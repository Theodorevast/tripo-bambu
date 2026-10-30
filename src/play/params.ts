import { WORK_SIZE } from '../planet/placement';

// 漫游的尺度和手感。世界单位是米：角色约 1 米高（翠宝的 GLB 本身 0.986 米），作品最长边 WORK_SIZE（1.6），
// 星球半径 PLANET_RADIUS（默认 30，可调）。角色和镜头的参数只跟角色的尺寸有关，和星球多大无关

export const CHAR_HEIGHT = 1.0; // 角色身高
export const CHAR_RADIUS = 0.36 * CHAR_HEIGHT; // 碰撞半径：翠宝的身体球半径约是身高的 0.36
// 两侧伸到多远：翠宝的手臂比身体宽（scripts/measure-clip.mjs 量的：站着 0.47，走起来手臂往外张一点）。
// 东西在角色侧面时按它挡（walker.ts 的 Obstacle.side），贴着作品侧着走过去手臂不插进去；正前方还是 CHAR_RADIUS
export const CHAR_SIDE = 0.5 * CHAR_HEIGHT;
export const WADE_DEPTH = 0.3 * CHAR_HEIGHT; // 水最多没到小腿：水底比水面低更多时，脚踩在水面下这么深的地方
export const NEAR_DISTANCE = 1.8 * WORK_SIZE; // 离作品中心这么近时显示标签、按 E 能打开

// 走路：速度和转身都是指数逼近（每秒的速率），和帧率无关
export const WALK = {
  speed: 2.4, // 每秒走多远（米）：1 米高的小角色小跑的速度
  accel: 10, // 速度逼近目标的速率
  turn: 12, // 朝向转向移动方向的速率
  arrive: 4, // 点地面自动走：离终点还有 d 时速度不超过 d × arrive，到点前慢下来
  stride: 0.7 * CHAR_HEIGHT, // 一步的长度：颠的快慢跟着走的距离（胶囊体占位用；翠宝的步长在 WALK_ANIM 里，跟着速度变）
  wadeSlow: 0.22, // 水没到 WADE_DEPTH 时走慢这么多（比例）：涉水的步子慢下来
};

// 翠宝的走路动画（gait.ts 算步态，character.ts 摆到各个部件上）：幅度、节奏都在这一张表里，
// ?tune 的「Walk animation」组直接改它，下一帧就用新值。长度单位米（角色 1 米高），角度弧度，时间秒，速率每秒
export const WALK_ANIM = {
  // —— 步子 ——
  stepBase: 0.2, // 一步的长度 = stepBase + stepPerSpeed × 速度（夹在 stepMin..stepMax）：走得越快步子越大、步频也越高
  stepPerSpeed: 0.125,
  stepMin: 0.14,
  stepMax: 0.6,
  dutySlow: 0.62, // 慢走时一只脚着地的时间占一个周期的比例（> 0.5：有两只脚都着地的一小段）
  dutyFast: 0.53, // 全速时
  minCadence: 2.8, // 走起来时每秒至少几步：起步的第一步不拖
  maxCadence: 7.5, // 每秒最多几步
  settleCadence: 3.4, // 停下、原地转身后收脚的步频
  settleError: 0.035, // 脚离站姿超过这么多（米；朝向差按 yawLever 折算）就要收一步
  yawLever: 0.12,
  turnStep: 0.55, // 原地转身：每转这么多弧度踩一步
  lift: 0.04, // 抬脚高度 = lift + liftPerStep × 这一步脚走的路程（全速时一步脚走约 1 米）
  liftPerStep: 0.065,
  footPitch: 0.32, // 迈步时脚尖先朝下（脚跟先抬）、落地前脚尖翘起（脚跟先着地）
  lockAt: 0.8, // 迈步走完这么多以后不再改落点
  // —— 身体 ——
  bob: 0.032, // 颠的幅度（米，全速；慢走时小一些）：刚落地时最低、两脚交错时最高
  bobDelay: 0.07, // 最低点在落地后多久（一步的比例）
  squash: 0.05, // 最低时压扁、最高时拉长的比例
  shift: 0.022, // 重心移到着地的那只脚上（米）
  shiftDelay: 0.03,
  roll: 0.05, // 跟着重心往着地的一侧歪
  twist: 0.12, // 肩膀转（弧度），胯反着转 hipTwist
  hipTwist: 0.1,
  leanSpeed: 0.07, // 全速时前倾
  leanAccel: 0.009, // 每 1 米/秒² 的加速度往前倾多少（减速往后仰）
  leanTurn: 0.015, // 转弯时往里倾（每 1 米/秒² 的侧向加速度）
  tiltMax: 0.18, // 往里倾最多这么多
  leanMax: 0.3,
  sink: 0.03, // 起步、刹车时身体往下沉（米，加速度到 accelRef 时）：起步的预备、停下的回弹
  accelRef: 15,
  leanSpring: 13, // 前倾、侧倾、下沉的弹簧角频率（1/秒）
  leanDamping: 0.42, // 阻尼比 < 1：停下时回弹一下
  // —— 手臂 ——
  armSwing: 0.42, // 全速时手臂前后摆的幅度（弧度）：和同侧的腿反着摆
  armDelay: 0.06, // 手臂比腿晚多少（一个周期的比例）
  handDelay: 0.07, // 手再晚多少
  handFollow: 0.6, // 手腕跟着甩的幅度（相对手臂）
  armOut: 0.08, // 走快时手臂往外张
  // —— 站着 ——
  breathSeconds: 3.4, // 一次呼吸
  breath: 0.022, // 呼吸时身体竖着伸缩的比例
  idleSway: 0.05, // 手臂轻轻晃
  idleSeconds: 2.8,
  // —— 涉水（水深到 WADE_DEPTH 时的量，浅一些按比例）——
  wadeStride: 0.12, // 步子长这么多（加上 WALK.wadeSlow 走慢了，步频明显慢下来）
  wadeLift: 0.7, // 抬脚高度多这么多倍
  wadeArms: 0.3, // 手臂往外抬
  wadeLean: 0.06, // 往前倾一点
  // —— 减少动态效果：身体、手臂的幅度乘这个（脚步照走，不会变回滑行）——
  reduced: 0.35,
};

// 跟随镜头：在角色后上方、拉远一些（look 调的）：翠宝只占画面高度的六分之一左右，站在弯下去的大星球上；越肩偏右，
// 前面的作品从角色旁边露出来。「上」是角色脚下的球面法线
export const FOLLOW = {
  distance: 7, // 镜头到注视点（原来 3.6：翠宝占画面三成，星球显得小）
  pitch: 0.23, // 俯角（弧度，约 13°）：地平线在画面中上部，脚下的草地和远处的云海都看得到
  aim: 0.38, // 镜头看向注视点上方这么高：角色落在画面中线偏下，前面的地平线露得多些
  shoulder: 0.8, // 越肩：镜头往角色右后方偏这么多（米），看的方向也偏过去，角色在画面中间偏左，前面的路露出来
  minPitch: 0.02,
  maxPitch: 1.15, // 约 66°：再往上就快成俯视了
  minDistance: 2.5,
  maxDistance: 14,
  focus: 0.62 * CHAR_HEIGHT, // 注视点在脚底上方多高
  follow: 7, // 注视点追角色的速率：镜头不是硬绑在角色身上，起步、停下都有一点滞后
  clearance: 0.35, // 镜头至少高出地面（或水面）这么多
  lift: 8, // 镜头被地形抬高时，抬高量逼近目标的速率
  autoTurn: 1.6, // 点地面自动走时，镜头转到角色身后的速率
  dragYaw: 0.006, // 拖动 1 像素转多少弧度
  dragPitch: 0.004,
  seconds: 1.2, // 进入、退出时镜头过渡的时长，和星球之间的镜头飞行一样
};
