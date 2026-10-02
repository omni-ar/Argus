const API_BASE_URL = '';

export type MissType = 'correct' | 'wrong_head' | 'wrong_target' | 'wrong_source' | 'missed_entirely' | 'late_source' | 'late_head';

export interface Rewards {
  source: string;
  target: string;
  head: string;
  total: string;
}

export interface EpochData {
  epoch: number;
  included: boolean;
  inclusionDelay: number | null;
  sourceCorrect: boolean;
  targetCorrect: boolean;
  headCorrect: boolean;
  missType: MissType;
  rewards: Rewards;
  missed: Rewards;
}

export interface MissingEpoch {
  epoch: number;
  reason: string;
  code?: string;
}

export interface ValidatorSummary {
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
}

export interface ValidatorResult {
  validatorIndex: number;
  pubkey: string;
  fromEpoch: number;
  toEpoch: number;
  epochs: EpochData[];
  missingEpochs: MissingEpoch[];
  summary: ValidatorSummary;
  error?: string;
  dataSource?: 'beacon_node' | 'local_snapshot';
}

export interface BatchPerformanceResponse {
  fromEpoch: number;
  toEpoch: number;
  results: ValidatorResult[];
}

export interface PerformanceQueryParams {
  days?: number;
  minutes?: number;
  fromEpoch?: number;
  toEpoch?: number;
}

/**
 * Fetches batch performance for all tracked validators
 * @param params Query params (days, minutes, or fromEpoch/toEpoch)
 */
export async function getBatchPerformance(params: PerformanceQueryParams = { minutes: 30 }): Promise<BatchPerformanceResponse> {
  const response = await fetch(`${API_BASE_URL}/api/validators/batch/performance`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    let errorMessage = `API Error: ${response.status} ${response.statusText}`;
    try {
        const errorData = await response.json();
        if (errorData.error) {
            errorMessage = errorData.error;
        }
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch(e) { /* ignore json parse error */ }
    throw new Error(errorMessage);
  }

  return response.json();
}
