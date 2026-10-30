// 用户自己的作品（上传的模型、用 Tripo 生成的模型）的存储层。
//
// 这一层只管「存」：GLB、缩略图和元数据。作品怎么并进团队、怎么变成页面上的 Work（blob URL）在 userWorksTeams.ts。
// 现在没有后端，存在浏览器的 IndexedDB 里（IdbUserWorksStore）；单元测试、隐私模式（IndexedDB 打不开）用内存实现（MemoryUserWorksStore）。
//
// 以后接后端：另写一个实现 UserWorksStore 的类（比如把 GLB、缩略图传到对象存储，元数据写进数据库），在 main.ts 里换掉 openUserWorks() 返回的实例，
// 别的代码不用动。约定：
// - list()：这个用户能看到的全部作品，按 createdAt 从早到晚排。返回的 glb、thumb 是 Blob（后端实现可以先下载下来，或者返回懒加载的 Blob）
// - add()：新增；id 已经存在时整条覆盖（改名就是改了 title 再 add 一次）。saved = false 表示只在内存里（刷新就没了），界面会提示
// - remove()：删掉一件；id 不存在时什么也不做
// - clear()：清空（Reset demo）
// - onChange()：增删改以后通知（参数是最新的完整列表），返回取消订阅的函数
// 元数据的字段见 UserWorkMeta；author 是成员 id（演示里就是 seed.you.memberId），authorHandle 是显示用的 @handle

export type UserWorkSource = 'upload' | 'tripo';
export type UserWorkMode = 'text' | 'image' | 'multiview';

export interface UserWorkMeta {
  id: string; // 作品 id：u- 开头（和种子作品、tmp- 开头的临时作品分开），也是分享链接里的 #/t/<团队>/museum/<id>
  title: string;
  author: string; // 作者的成员 id
  authorHandle?: string; // 作者的 @handle（不带 @）：作品加到别的团队时，那个团队的成员里没有作者，Museum、路牌照样写得出名字
  source: UserWorkSource;
  prompt?: string; // Tripo 文字生成的提示词
  mode?: UserWorkMode; // Tripo 生成方式
  createdAt: number; // 毫秒
  triangles: number; // 优化后的三角面数
  bytes: number; // 优化后的 GLB 字节数
  teamId: string; // 归哪个团队（在哪颗星球上加的）
}

export interface UserWork extends UserWorkMeta {
  glb: Blob; // 优化后的 GLB（model/gltf-binary）
  thumb: Blob | null; // 缩略图（image/webp，透明背景）；渲染不出来时是 null，界面用缩写色块
}

export interface UserWorksStore {
  list(): Promise<UserWork[]>;
  add(work: UserWork): Promise<{ saved: boolean }>;
  remove(id: string): Promise<void>;
  clear(): Promise<void>;
  onChange(listener: (works: UserWork[]) => void): () => void;
  readonly persistent: boolean; // 刷新以后还在不在（IndexedDB 打不开时退回内存，false）
}

// 新作品的 id：u- + 时间 + 随机数（36 进制）。只用小写字母、数字和 -，放进地址里不用转义
export function newUserWorkId(now = Date.now(), random = Math.random): string {
  return `u-${now.toString(36)}-${Math.floor(random() * 36 ** 6).toString(36).padStart(6, '0')}`;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

// 读回来的记录逐个字段核对，只留认识的字段（旧版本、手改过的数据不会把页面弄坏）；不对就整条不要
export function toUserWork(v: unknown): UserWork | null {
  if (!isRecord(v)) return null;
  const { id, title, author, authorHandle, source, prompt, mode, createdAt, triangles, bytes, teamId, glb, thumb } = v;
  if (!isText(id, 120) || !/^u-[a-z0-9-]+$/.test(id) || !isText(title, 200) || !isText(author, 80) || !isText(teamId, 80) || !teamId) return null;
  if (source !== 'upload' && source !== 'tripo') return null;
  if (!isCount(createdAt) || !isCount(triangles) || !isCount(bytes)) return null;
  if (!(glb instanceof Blob) || (thumb !== null && thumb !== undefined && !(thumb instanceof Blob))) return null;
  const work: UserWork = { id, title, author, source, createdAt, triangles, bytes, teamId, glb, thumb: thumb ?? null };
  if (isText(authorHandle, 60)) work.authorHandle = authorHandle;
  if (isText(prompt, 2000)) work.prompt = prompt;
  if (mode === 'text' || mode === 'image' || mode === 'multiview') work.mode = mode;
  return work;
}

const byCreated = (a: UserWork, b: UserWork): number => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// 通知监听者的公共部分
abstract class BaseStore {
  private readonly listeners = new Set<(works: UserWork[]) => void>();

  onChange(listener: (works: UserWork[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  protected async emit(list: () => Promise<UserWork[]>): Promise<void> {
    if (!this.listeners.size) return;
    const works = await list();
    for (const fn of [...this.listeners]) {
      try {
        fn(works);
      } catch (err) {
        console.error(err);
      }
    }
  }
}

// 内存实现：单元测试用；IndexedDB 打不开（隐私模式、被禁用）时也用它，作品只活到关掉页面
export class MemoryUserWorksStore extends BaseStore implements UserWorksStore {
  readonly persistent = false;
  private readonly works = new Map<string, UserWork>();

  async list(): Promise<UserWork[]> {
    return [...this.works.values()].map((w) => ({ ...w })).sort(byCreated);
  }

  async add(work: UserWork): Promise<{ saved: boolean }> {
    const checked = toUserWork(work);
    if (!checked) throw new Error('Invalid user work');
    this.works.set(checked.id, checked);
    await this.emit(() => this.list());
    return { saved: false };
  }

  async remove(id: string): Promise<void> {
    if (!this.works.delete(id)) return;
    await this.emit(() => this.list());
  }

  async clear(): Promise<void> {
    if (!this.works.size) return;
    this.works.clear();
    await this.emit(() => this.list());
  }
}

export const IDB_NAME = 'gbn-user-works';
export const IDB_STORE = 'works';
const IDB_VERSION = 1;

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

// IndexedDB 实现：一个库 gbn-user-works，一张表 works（主键 id），每条记录 = 元数据 + glb、thumb 两个 Blob。
// Blob 由浏览器存成文件，读列表时只拿到引用，不把几十 MB 读进内存
export class IdbUserWorksStore extends BaseStore implements UserWorksStore {
  readonly persistent = true;
  private readonly db: IDBDatabase;

  private constructor(db: IDBDatabase) {
    super();
    this.db = db;
  }

  // 打不开（没有 IndexedDB、隐私模式、版本冲突）时抛错，调用方退回内存实现
  static async open(factory: IDBFactory = indexedDB): Promise<IdbUserWorksStore> {
    const req = factory.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, { keyPath: 'id' });
    };
    const db = await request(req);
    // 别的标签页升级了库：关掉这边的连接，免得挡住它（这一页之后的写入会失败，刷新后恢复）
    db.onversionchange = () => db.close();
    return new IdbUserWorksStore(db);
  }

  async list(): Promise<UserWork[]> {
    const tx = this.db.transaction(IDB_STORE, 'readonly');
    const rows = await request(tx.objectStore(IDB_STORE).getAll());
    return rows.map(toUserWork).filter((w): w is UserWork => w !== null).sort(byCreated);
  }

  async add(work: UserWork): Promise<{ saved: boolean }> {
    const checked = toUserWork(work);
    if (!checked) throw new Error('Invalid user work');
    const tx = this.db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(checked);
    await done(tx);
    await this.emit(() => this.list());
    return { saved: true };
  }

  async remove(id: string): Promise<void> {
    const tx = this.db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(id);
    await done(tx);
    await this.emit(() => this.list());
  }

  async clear(): Promise<void> {
    const tx = this.db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).clear();
    await done(tx);
    await this.emit(() => this.list());
  }
}

// 浏览器里打开存储：IndexedDB 优先，打不开就用内存（作品只活到关掉页面，界面会提示）
export async function openUserWorks(): Promise<UserWorksStore> {
  try {
    if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is not available');
    return await IdbUserWorksStore.open();
  } catch (err) {
    console.warn('user works: IndexedDB unavailable, keeping them in memory', err);
    return new MemoryUserWorksStore();
  }
}
