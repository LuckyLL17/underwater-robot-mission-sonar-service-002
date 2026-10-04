import type { Point, Telemetry } from '../domain/types.js';

// 水下链路乱序/重复常见：同一任务的迟到旧帧不得覆盖最新有效状态。
export type TelemetryOutcome = { kind: 'fresh'; reason?: undefined } | { kind: 'duplicate' | 'stale-time'; reason: 'duplicate' | 'stale-time' };

export function samePosition(a: Point, b: Point) { return a.x === b.x && a.y === b.y && a.z === b.z; }

export function isDuplicate(candidate: Telemetry, latest: Telemetry) {
	return samePosition(candidate.position, latest.position)
		&& candidate.timeMs === latest.timeMs
		&& candidate.batteryWh === latest.batteryWh
		&& candidate.speedMs === latest.speedMs
		&& candidate.headingDeg === latest.headingDeg;
}

// 只依据目标任务自己的最新一条有效遥测判定，跨任务数据互不影响。
export function classifyTelemetry(candidate: Telemetry, latest: Telemetry | undefined): TelemetryOutcome {
	if (latest) {
		if (isDuplicate(candidate, latest)) return { kind: 'duplicate', reason: 'duplicate' };
		if (candidate.timeMs < latest.timeMs) return { kind: 'stale-time', reason: 'stale-time' };
	}
	return { kind: 'fresh' };
}
