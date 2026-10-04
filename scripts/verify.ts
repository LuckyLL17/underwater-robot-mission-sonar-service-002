import assert from 'node:assert';
import { buildApp } from '../src/app.js';

const app = await buildApp();
let pass = 0;
const ok = (name: string) => { console.log('PASS', name); pass++; };

const j = async (method: string, url: string, body?: any) => {
  const res = await app.inject({ method, url, payload: body });
  return { status: res.statusCode, body: res.json() };
};

// ---- 建两个任务并各自规划/校验/审批 ----
const a = (await j('POST', '/api/missions', { name: '任务A', robotId: 'AUV-07' })).body;
const b = (await j('POST', '/api/missions', { name: '任务B', robotId: 'AUV-07' })).body;

const wpa = [
  { x: 0, y: 0, z: 0, dwellSec: 0, speedMs: 1.6 },
  { x: 125, y: 0, z: 0, dwellSec: 0, speedMs: 1.6 },
  { x: 200, y: 0, z: 0, dwellSec: 0, speedMs: 1.6 },
];
const wpb = [
  { x: 2000, y: 2000, z: 0, dwellSec: 0, speedMs: 1.6 },
  { x: 2100, y: 2000, z: 0, dwellSec: 0, speedMs: 1.6 },
];
const pa = (await j('POST', `/api/missions/${a.id}/plan`, { waypoints: wpa })).body;
const pb = (await j('POST', `/api/missions/${b.id}/plan`, { waypoints: wpb })).body;
(await j('POST', `/api/plans/${pa.id}/validate`, {}));
(await j('POST', `/api/plans/${pb.id}/validate`, { startPosition: { x: 2000, y: 2000, z: 0 } }));
await j('POST', `/api/missions/${a.id}/approve`, {});
await j('POST', `/api/missions/${b.id}/approve`, {});

const tel = async (mid: string, timeMs: number, position: any, batteryWh: number) =>
  j('POST', `/api/missions/${mid}/telemetry`, { timeMs, position, batteryWh });

// ---- 1) 两个任务交错上报：遥测带任务归属，互不覆盖 ----
let r = await tel(a.id, 1000, { x: 10, y: 0, z: 0 }, 15000);
assert.equal(r.body.telemetry.missionId, a.id, '遥测应带 missionId');
assert.equal(r.body.accepted, true);
assert.equal(r.body.stateUpdated, true);
await tel(b.id, 2000, { x: 2000, y: 2000, z: 0 }, 15000);
await tel(a.id, 3000, { x: 50, y: 0, z: 0 }, 14900);
await tel(b.id, 4000, { x: 2010, y: 2000, z: 0 }, 14800);

let da = (await j('GET', `/api/missions/${a.id}/dossier`)).body;
let db = (await j('GET', `/api/missions/${b.id}/dossier`)).body;
assert.deepEqual(da.latestTelemetry.position, { x: 50, y: 0, z: 0 }, 'A 最新遥测不被 B 覆盖');
assert.deepEqual(db.latestTelemetry.position, { x: 2010, y: 2000, z: 0 }, 'B 最新遥测不被 A 覆盖');
assert.equal(da.latestTelemetry.missionId, a.id);
assert.equal(db.latestTelemetry.missionId, b.id);
ok('两个任务交错上报，各自最新状态按 missionId 隔离');

// ---- 2) 重复遥测：不覆盖最新状态 ----
r = await tel(a.id, 3000, { x: 50, y: 0, z: 0 }, 14900);
assert.equal(r.body.duplicate, true);
assert.equal(r.body.stateUpdated, false);
assert.equal(r.body.telemetry.ignored, true);
assert.equal(r.body.telemetry.ignoreReason, 'duplicate');
da = (await j('GET', `/api/missions/${a.id}/dossier`)).body;
assert.equal(da.latestTelemetry.timeMs, 3000);
ok('重复遥测被标记且不覆盖最新状态');

// ---- 3) 时间倒退遥测：不覆盖最新状态，且不触发安全处理 ----
r = await tel(a.id, 500, { x: 5, y: 0, z: 0 }, 14950);
assert.equal(r.body.stale, true);
assert.equal(r.body.stateUpdated, false);
assert.equal(r.body.telemetry.ignoreReason, 'stale-time');
ok('时间倒退遥测被识别为 stale');

// 旧帧落在禁入区（x 700 y 400 z 240 ∈ GF-01），但因为时间倒退不应触发 safety-hold
r = await tel(a.id, 600, { x: 700, y: 400, z: 240 }, 14900);
assert.equal(r.body.stale, true);
assert.equal(r.body.mission.status, 'approved', '旧帧禁入区不得改写任务安全状态');
da = (await j('GET', `/api/missions/${a.id}/dossier`)).body;
assert.deepEqual(da.latestTelemetry.position, { x: 50, y: 0, z: 0 }, '旧帧不得覆盖最新位置');
ok('倒退的禁入区旧帧不触发安全处理');

// ---- 4) 重规划只使用目标任务最近一次有效遥测 ----
// 先让 B 再上报一条，使「全局最后一条遥测」属于 B（旧代码会误用它）
await tel(b.id, 4500, { x: 2015, y: 2000, z: 0 }, 14700);

r = await j('POST', `/api/missions/${a.id}/replan`, {});
assert.equal(r.status, 200);
// A 的有效最新位置是 (50,0,0)；三个航点都在 20m 外故全保留：50+125+75=250m
assert.ok(Math.abs(r.body.estimate.distanceM - 250) < 1e-6, `A 重规划距离应为 250，实际 ${r.body.estimate.distanceM}`);
assert.deepEqual(r.body.waypoints.map((w: any) => [w.x, w.y, w.z]), [[0, 0, 0], [125, 0, 0], [200, 0, 0]]);
ok('A 重规划起点取自 A 自己的最新遥测，未受 B 全局末条/旧帧影响');

// ---- 5) 安全处理保留：低电量 -> return-required，新帧进入禁区 -> safety-hold ----
r = await tel(b.id, 5000, { x: 2015, y: 2000, z: 0 }, 1000);
assert.equal(r.body.mission.status, 'return-required', '低电量应触发 return-required');
ok('低电量保留 return-required 处理');

r = await tel(b.id, 6000, { x: 700, y: 400, z: 240 }, 9900);
assert.equal(r.body.mission.status, 'safety-hold', '新帧进入禁区应触发 safety-hold');
ok('新帧进入禁区保留 safety-hold 处理');

// B 重规划以 B 自己的最新位置 (700,400,240) 为起点
r = await j('POST', `/api/missions/${b.id}/replan`, {});
const expected = Math.hypot(700 - 2000, 400 - 2000, 240) + Math.hypot(2000 - 2100, 0, 0);
assert.ok(Math.abs(r.body.estimate.distanceM - Number(expected.toFixed(2))) < 1e-6,
  `B 重规划距离应基于 B 的最新位置，实际 ${r.body.estimate.distanceM}，期望 ${expected.toFixed(2)}`);
ok('B 重规划起点取自 B 自己的最新遥测（含禁区位置）');

// ---- 6) 档案遥测计数按任务归属 ----
da = (await j('GET', `/api/missions/${a.id}/dossier`)).body;
db = (await j('GET', `/api/missions/${b.id}/dossier`)).body;
assert.equal(da.telemetryCount, 5, 'A 共上报 5 条（含重复/倒退，均留痕）');
assert.equal(db.telemetryCount, 5, 'B 共上报 5 条');
ok('档案遥测计数按 missionId 隔离');

console.log(`\n全部 ${pass} 项验证通过`);
await app.close();
