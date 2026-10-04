export type Point = { x: number; y: number; z: number };
export type Waypoint = Point & { dwellSec: number; speedMs: number };
export type Telemetry = { missionId: string; timeMs: number; position: Point; headingDeg: number; speedMs: number; batteryWh: number; current: Point; quality: 'good' | 'suspect' | 'bad'; ignored?: boolean; ignoreReason?: 'duplicate' | 'stale-time' };
export type Target = { id: string; position: Point; class: 'wreck' | 'pipeline' | 'mine-like' | 'unknown'; confidence: number; status: 'candidate' | 'confirmed' | 'rejected'; evidence: any[] };
