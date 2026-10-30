import type { App } from '../app';
import { browserStorage } from '../data/store';
import type { Work } from '../data/types';
import type { Editor } from '../editor/editor';
import { parseRoute } from '../router';
import { AddWorkDialog } from '../ui/genaiDialog';
import { GenNotice } from '../ui/genaiNotice';
import { toast } from '../ui/toast';
import { importModelFile } from '../works/importClient';
import { thumbnailOf } from '../works/modelStage';
import { newUserWorkId, type UserWork } from '../works/userWorks';
import type { PlanetStoreWithUserWorks, UserWorksRegistry } from '../works/userWorksTeams';
import { tripoApiForPage } from './api';
import { GenJobs } from './jobs';
import { describeError } from './messages';
import type { GenJob } from './types';

// 上传、Tripo 生成装进页面（main.ts 调一次）：
// - 生成任务（GenJobs）不依赖窗口：窗口关着、刷新以后照样轮询；成功后下载 GLB → 同一条导入管线（Worker）→ 截缩略图 → 存进 IndexedDB → 加进团队
// - 作品栏的「Upload」「Create with Tripo」打开窗口；完成、失败时右下角弹提示，点它回到窗口看结果
// - Reset demo 时一起清掉生成任务（用户作品由 PlanetStoreWithUserWorks 清）
// 给自查脚本的：window.__genai

declare global {
  interface Window {
    __genai?: {
      state(): Record<string, unknown>;
      jobs(): GenJob[];
      open(tab?: 'upload' | 'text' | 'image' | 'multiview'): void;
      close(): void;
    };
  }
}

// 当前用户的 @handle（不带 @）：作品加到别的团队时用它显示作者
function youHandle(app: App): string | undefined {
  return app.teams.flatMap((t) => t.members).find((m) => m.id === app.you.memberId)?.handle;
}

// opts.beforePlace：「Add to planet」进入摆放之前调（main.ts 接上：先退出漫游）
export function installGenAI(app: App, editor: Editor, registry: UserWorksRegistry, store: PlanetStoreWithUserWorks, opts: { beforePlace?: () => void } = {}): AddWorkDialog {
  const api = tripoApiForPage();

  // 作品加进团队：App 的团队列表、星系里那颗星球的数据、正在看的星球视图和作品栏一起换上新的
  const attach = (work: Work, teamId: string): void => {
    const team = app.teams.find((t) => t.id === teamId);
    if (!team) return;
    const next = { ...team, works: [...team.works.filter((w) => w.id !== work.id), work] };
    app.replaceTeam(next);
    editor.syncTeam(next);
  };

  // 生成成功：下载好的 GLB 走同一条导入管线，截缩略图，存进本地，加进发起任务的那个团队
  const finish = async (job: GenJob, glb: Blob): Promise<{ workId: string }> => {
    const result = await importModelFile(glb, `${job.title || 'model'}.glb`);
    const thumb = await thumbnailOf(result.glb);
    const record: UserWork = {
      id: newUserWorkId(),
      title: job.title,
      author: app.you.memberId,
      source: 'tripo',
      mode: job.mode,
      createdAt: Date.now(),
      triangles: result.triangles,
      bytes: result.bytes,
      teamId: job.teamId,
      glb: new Blob([result.glb as Uint8Array<ArrayBuffer>], { type: 'model/gltf-binary' }),
      thumb,
    };
    if (job.prompt) record.prompt = job.prompt;
    const handle = youHandle(app);
    if (handle) record.authorHandle = handle;
    const { work } = await registry.add(record);
    attach(work, job.teamId);
    return { workId: record.id };
  };

  const jobs = new GenJobs({ api, storage: browserStorage(), finish });

  // 「Add to planet」：关掉窗口，进入摆放。要在那颗星球的星球页上（不是它的 Members / Museum 页，那时编辑器在页面底下）：
  // 不在就先过去（作品属于别的星球、或者从 Museum 里点了完成提示），转场落定了再进入摆放。漫游中先退出漫游（编辑和漫游互斥）
  let placing = 0;
  const onPlanetPage = (teamId: string): boolean => {
    const route = parseRoute(location.hash);
    return route.view === 'planet' && route.teamId === teamId && app.currentTeam?.id === teamId;
  };
  const place = (workId: string, teamId: string): void => {
    dialog.close();
    const work = registry.work(workId);
    if (!work) return;
    const token = ++placing;
    opts.beforePlace?.();
    const tryPlace = (): boolean => {
      if (app.routing || !onPlanetPage(teamId)) return false;
      const w = registry.work(workId) ?? work;
      if (!editor.placeWork(w)) return false;
      toast(`Click the planet to place ${w.title}`);
      return true;
    };
    if (tryPlace()) return;
    if (!onPlanetPage(teamId)) app.navigate({ view: 'planet', teamId });
    const started = performance.now();
    const tick = (): void => {
      if (token !== placing || tryPlace() || performance.now() - started > 20000) return;
      setTimeout(tick, 150);
    };
    setTimeout(tick, 150);
  };

  const dialog = new AddWorkDialog({ app, registry, jobs, api, attach, place });
  const notice = new GenNotice(app.root);

  // 完成、失败时：窗口没在显示这个任务，就弹右下角的提示
  jobs.subscribe(({ job, from }) => {
    if (from === job.phase || dialog.isShowing(job.id)) return;
    if (job.phase === 'done') {
      notice.show({ tone: 'done', title: job.title, text: 'Your Tripo model is ready', action: 'View', onAction: () => { jobs.markSeen(job.id); dialog.open(undefined, job.id); } });
    } else if (job.phase === 'failed') {
      const message = job.error?.message ?? describeError('upstream');
      notice.show({ tone: 'failed', title: job.title, text: message, action: 'Details', onAction: () => dialog.open(undefined, job.id), ms: 16000 });
    }
  });

  editor.onAddWork = (tab) => dialog.open(tab);
  store.onReset(() => jobs.clear());
  // 刷新前没做完的任务：接着轮询（窗口不用打开）
  jobs.resume();
  if (!registry.persistent) console.warn('user works: this browser cannot keep them after the tab closes');

  window.__genai = {
    state: () => ({ ...dialog.debugState(), notice: notice.shown }),
    jobs: () => jobs.list(),
    open: (tab) => dialog.open(tab),
    close: () => dialog.close(),
  };
  return dialog;
}
