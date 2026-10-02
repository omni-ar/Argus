import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

type MissType =
  | "correct"
  | "wrong_head"
  | "wrong_target"
  | "wrong_source"
  | "missed_entirely"
  | "late_source"
  | "late_head";

interface SnapshotEpoch {
  epoch: number;
  included: boolean;
  inclusionDelay: number | null;
  timelySource: boolean;
  timelyTarget: boolean;
  timelyHead: boolean;
  missType: MissType;
  baseReward: string;
  sourceMissed: string;
  targetMissed: string;
  headMissed: string;
  totalEarned: string;
  totalMissed: string;
}

interface SnapshotValidator {
  validatorIndex: number;
  pubkey: string;
  fromEpoch: number;
  toEpoch: number;
  ours: { deepEpochDetails: SnapshotEpoch[] };
}

interface SnapshotFile {
  validators: SnapshotValidator[];
}

export interface SnapshotPerformanceResult {
  validatorIndex: number;
  pubkey: string;
  fromEpoch: number;
  toEpoch: number;
  epochs: Array<{
    epoch: number;
    included: boolean;
    inclusionDelay: number | null;
    sourceCorrect: boolean;
    targetCorrect: boolean;
    headCorrect: boolean;
    missType: MissType;
    rewards: { source: string; target: string; head: string; total: string };
    missed: { source: string; target: string; head: string; total: string };
    baseReward: string;
    dataSource: "local_snapshot";
  }>;
  missingEpochs: [];
  summary: {
    epochsChecked: number;
    correct: number;
    wrongHead: number;
    wrongTarget: number;
    wrongSource: number;
    missed: number;
    lateSource: number;
    lateHead: number;
    avgInclusionDelay: number | null;
    totalEarnedGwei: string;
    totalMissedGwei: string;
    totalMissedEth: string;
    sourceMissedGwei: string;
    targetMissedGwei: string;
    headMissedGwei: string;
    sourceMissedEth: string;
    targetMissedEth: string;
    headMissedEth: string;
  };
  dataSource: "local_snapshot";
}

let snapshot: SnapshotFile | undefined;

function loadSnapshot(): SnapshotFile {
  if (snapshot) return snapshot;
  const currentDir = dirname(fileURLToPath(import.meta.url));
  const candidatePaths = [
    resolve(process.cwd(), "reconciliation_output.json"),
    resolve(process.cwd(), "backend", "reconciliation_output.json"),
    resolve(currentDir, "../../../reconciliation_output.json"),
    resolve(currentDir, "../../reconciliation_output.json"),
  ];
  for (const candidate of candidatePaths) {
    if (existsSync(candidate)) {
      snapshot = JSON.parse(readFileSync(candidate, "utf8")) as SnapshotFile;
      return snapshot;
    }
  }
  throw new Error(`reconciliation_output.json not found in candidate paths: ${candidatePaths.join(", ")}`);
}

function eth(gwei: bigint): string {
  return `${gwei / 1_000_000_000n}.${(gwei % 1_000_000_000n).toString().padStart(9, "0")}`;
}

export function getSnapshotResults(identifiers: unknown[]): SnapshotPerformanceResult[] {
  const validators = loadSnapshot().validators;
  const selected = identifiers.length
    ? validators.filter((validator) =>
        identifiers.some((identifier) =>
          String(identifier).toLowerCase() === String(validator.validatorIndex) ||
          String(identifier).toLowerCase() === validator.pubkey.toLowerCase(),
        ),
      )
    : validators;

  const toReturn = selected.length > 0 ? selected : validators;
  return toReturn.map((validator) => {
    let totalEarned = 0n;
    let totalMissed = 0n;
    let sourceMissed = 0n;
    let targetMissed = 0n;
    let headMissed = 0n;
    let totalDelay = 0;
    let delayCount = 0;
    const counts: Record<MissType, number> = {
      correct: 0, wrong_head: 0, wrong_target: 0, wrong_source: 0,
      missed_entirely: 0, late_source: 0, late_head: 0,
    };
    const epochs = validator.ours.deepEpochDetails.map((entry) => {
      totalEarned += BigInt(entry.totalEarned);
      totalMissed += BigInt(entry.totalMissed);
      sourceMissed += BigInt(entry.sourceMissed);
      targetMissed += BigInt(entry.targetMissed);
      headMissed += BigInt(entry.headMissed);
      counts[entry.missType]++;
      if (entry.inclusionDelay !== null) {
        totalDelay += entry.inclusionDelay;
        delayCount++;
      }
      const source = BigInt(entry.baseReward) / 4n;
      const target = BigInt(entry.baseReward) / 4n + BigInt(entry.baseReward) / 8n;
      const head = BigInt(entry.baseReward) / 4n - BigInt(entry.baseReward) / 32n;
      return {
        epoch: entry.epoch,
        included: entry.included,
        inclusionDelay: entry.inclusionDelay,
        sourceCorrect: entry.timelySource,
        targetCorrect: entry.timelyTarget,
        headCorrect: entry.timelyHead,
        missType: entry.missType,
        rewards: { source: source.toString(), target: target.toString(), head: head.toString(), total: entry.totalEarned },
        missed: { source: entry.sourceMissed, target: entry.targetMissed, head: entry.headMissed, total: entry.totalMissed },
        baseReward: entry.baseReward,
        dataSource: "local_snapshot" as const,
      };
    });
    return {
      validatorIndex: validator.validatorIndex,
      pubkey: validator.pubkey,
      fromEpoch: validator.fromEpoch,
      toEpoch: validator.toEpoch,
      epochs,
      missingEpochs: [],
      summary: {
        epochsChecked: epochs.length,
        correct: counts.correct, wrongHead: counts.wrong_head, wrongTarget: counts.wrong_target,
        wrongSource: counts.wrong_source, missed: counts.missed_entirely,
        lateSource: counts.late_source, lateHead: counts.late_head,
        avgInclusionDelay: delayCount ? Math.round((totalDelay / delayCount) * 100) / 100 : null,
        totalEarnedGwei: totalEarned.toString(), totalMissedGwei: totalMissed.toString(), totalMissedEth: eth(totalMissed),
        sourceMissedGwei: sourceMissed.toString(), targetMissedGwei: targetMissed.toString(), headMissedGwei: headMissed.toString(),
        sourceMissedEth: eth(sourceMissed), targetMissedEth: eth(targetMissed), headMissedEth: eth(headMissed),
      },
      dataSource: "local_snapshot" as const,
    };
  });
}
