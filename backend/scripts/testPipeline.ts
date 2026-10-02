/**
 * End-to-end integration test for the on-chain reward computation pipeline.
 *
 * Exercises the full path:
 *   pubkey resolution (beaconcha.in) →
 *   committee assignment (beacon node) →
 *   attestation inclusion scan (beacon node) →
 *   checkpoint verification (beacon node) →
 *   Altair reward calculation (rewardCalculator.ts)
 *
 * Run with:
 *   pnpm pipeline
 */

import 'dotenv/config';
import { logger } from '../src/utils/logger.js';
import { getFinalizedEpochCached } from '../src/utils/epochUtils.js';
import { getValidatorInfo } from '../src/clients/beaconchainClient.js';
import {
  computeEpochRangeRewards,
  type ComputedEpochResult,
} from '../src/services/attestationService.js';
import { validatorMissedAttestations, register } from '../src/monitoring/metrics.js';
import { VALIDATOR_PUBKEYS } from '../constants.js';

/** Number of most-recent finalized epochs to test per validator. */
const PIPELINE_EPOCHS = 3;

// ─── Table rendering ──────────────────────────────────────────────────────────

interface TableRow {
  epoch: number;
  validatorIndex: number;
  included: string;
  delay: string;
  source: string;
  target: string;
  head: string;
  missType: string;
  earnedGwei: string;
  missedGwei: string;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + ' '.repeat(width - s.length);
}

function printTable(rows: TableRow[]): void {
  const cols: Array<{ key: keyof TableRow; label: string; width: number }> = [
    { key: 'epoch',          label: 'Epoch',       width: 9  },
    { key: 'validatorIndex', label: 'Validator',   width: 10 },
    { key: 'included',       label: 'Included',    width: 9  },
    { key: 'delay',          label: 'Delay',       width: 6  },
    { key: 'source',         label: 'Source',      width: 7  },
    { key: 'target',         label: 'Target',      width: 7  },
    { key: 'head',           label: 'Head',        width: 7  },
    { key: 'missType',       label: 'Miss Type',   width: 16 },
    { key: 'earnedGwei',     label: 'Earned (Gwei)', width: 18 },
    { key: 'missedGwei',     label: 'Missed (Gwei)', width: 18 },
  ];

  const separator = cols.map(c => '-'.repeat(c.width)).join('-+-');
  const header    = cols.map(c => pad(c.label, c.width)).join(' | ');

  console.log('\n' + separator);
  console.log(header);
  console.log(separator);

  for (const row of rows) {
    const line = cols.map(c => pad(String(row[c.key]), c.width)).join(' | ');
    console.log(line);
  }

  console.log(separator + '\n');
}

// ─── Summary ──────────────────────────────────────────────────────────────────

interface ValidatorSummary {
  validatorIndex: number;
  pubkey: string;
  epochsFetched: number;
  epochsComputed: number;
  epochsMissing: number;
  totalEarnedGwei: bigint;
  totalMissedGwei: bigint;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Step 1: Fetch finalized epoch from beacon node
  const finalizedEpoch = await getFinalizedEpochCached();
  const fromEpoch = Math.max(0, finalizedEpoch - PIPELINE_EPOCHS + 1);

  logger.info('Pipeline started', {
    finalizedEpoch,
    fromEpoch,
    toEpoch: finalizedEpoch,
    epochsPerValidator: PIPELINE_EPOCHS,
  });

  const tableRows: TableRow[] = [];
  const summaries: ValidatorSummary[] = [];

  // Step 2: Resolve each pubkey → validator index, then compute rewards
  for (const pubkey of VALIDATOR_PUBKEYS) {
    let validatorIndex: number;

    try {
      const info = await getValidatorInfo(pubkey);
      validatorIndex = info.validatorindex;
      logger.info('Resolved validator', {
        pubkey: pubkey.slice(0, 14) + '...',
        validatorIndex,
      });
    } catch (err) {
      const e = err as { code: string; message: string };
      logger.error('Failed to resolve validator pubkey, skipping', {
        code: e.code,
        message: e.message,
        pubkey: pubkey.slice(0, 14) + '...',
      });
      continue;
    }

    // Step 3: On-chain computation via attestationService
    const { results, missingEpochs } = await computeEpochRangeRewards(
      validatorIndex,
      fromEpoch,
      finalizedEpoch,
    );

    // Step 4: Update Prometheus gauges
    let sourceMisses = 0, targetMisses = 0, headMisses = 0;
    for (const r of results) {
      if (!r.timelySource) sourceMisses++;
      if (!r.timelyTarget) targetMisses++;
      if (!r.timelyHead)   headMisses++;
    }
    validatorMissedAttestations.set(
      { validator_index: String(validatorIndex), component: 'source' },
      sourceMisses,
    );
    validatorMissedAttestations.set(
      { validator_index: String(validatorIndex), component: 'target' },
      targetMisses,
    );
    validatorMissedAttestations.set(
      { validator_index: String(validatorIndex), component: 'head' },
      headMisses,
    );

    // Step 5: Accumulate table rows
    for (const r of results) {
      tableRows.push(epochResultToRow(r));
    }

    // Step 6: Accumulate summary
    const totalEarnedGwei = results.reduce((acc, r) => acc + BigInt(r.totalEarned), 0n);
    const totalMissedGwei = results.reduce((acc, r) => acc + BigInt(r.totalMissed), 0n);

    summaries.push({
      validatorIndex,
      pubkey,
      epochsFetched: results.length + missingEpochs.length,
      epochsComputed: results.length,
      epochsMissing: missingEpochs.length,
      totalEarnedGwei,
      totalMissedGwei,
    });

    if (missingEpochs.length > 0) {
      logger.warn('Some epochs could not be computed', {
        validatorIndex,
        missingEpochs: missingEpochs.map(m => `${m.epoch}(${m.code ?? m.reason})`).join(', '),
      });
    }
  }

  // Step 7: Print results
  printTable(tableRows);

  console.log('Per-validator cumulative summary:');
  console.log('─'.repeat(90));
  for (const s of summaries) {
    console.log(
      `  Validator ${String(s.validatorIndex).padEnd(8)}` +
      `  computed: ${s.epochsComputed}/${s.epochsFetched}` +
      `  missing: ${s.epochsMissing}` +
      `  earned: ${s.totalEarnedGwei} Gwei` +
      `  missed: ${s.totalMissedGwei} Gwei`,
    );
  }

  const metricsOutput = await register.metrics();
  console.log('\n=== /metrics output ===\n');
  console.log(metricsOutput);

  logger.info('Pipeline complete', {
    validatorsProcessed: summaries.length,
    totalEpochRows: tableRows.length,
  });
}

function epochResultToRow(r: ComputedEpochResult): TableRow {
  return {
    epoch:          r.epoch,
    validatorIndex: r.validatorIndex,
    included:       r.included ? 'yes' : 'NO',
    delay:          r.inclusionDelay !== null ? String(r.inclusionDelay) : '-',
    source:         r.timelySource ? 'ok' : 'MISS',
    target:         r.timelyTarget ? 'ok' : 'MISS',
    head:           r.timelyHead   ? 'ok' : 'MISS',
    missType:       r.missType,
    earnedGwei:     r.totalEarned,
    missedGwei:     r.totalMissed,
  };
}

main().catch((err) => {
  logger.error('Pipeline fatal error', {
    code: (err as { code?: string }).code ?? 'UNKNOWN',
    message: String(err),
  });
  process.exit(1);
});
