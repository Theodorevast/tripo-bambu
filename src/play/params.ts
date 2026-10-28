import { WORK_SIZE } from '../planet/placement';

// 漫游的尺度和手感。世界单位是米：角色约 1 米高（翠宝的 GLB 本身 0.986 米），作品最长边 WORK_SIZE（1.6），
// 星球半径 PLANET_RADIUS（默认 30，可调）。角色和镜头的参数只跟角色的尺寸有关，和星球多大无关

export const CHAR_HEIGHT = 1.0; // 角色身高
export const CHAR_RADIUS = 0.36 * CHAR_HEIGHT; // 碰撞半径：翠宝的身体球半径约是身高的 0.36
export const WADE_DEPTH = 0.3 * CHAR_HEIGHT; // 水最多没到小腿：水底比水面低更多时，脚踩在水面下这么深的地方
export const NEAR_DISTANCE = 1.8 * WORK_SIZE; // 离作品中心这么近时显示标签、按 E 能打开

// 走路：速度和转身都是指数逼近（每秒的速率），和帧率无关
export const WALK = {
  speed: 2.4, // 每秒走多远（米）：1 米高的小角色小跑的速度
  accel: 10, // 速度逼近目标的速率
  turn: 12, // 朝向转向移动方向的速率
  arrive: 4, // 点地面自动走：离终点还有 d 时速度不超过 d × arrive，到点前慢下来
  stride: 0.7 * CHAR_HEIGHT, // 一步的长度：颠的快慢跟着走的距离
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
