import { useState, useEffect, useCallback } from 'react';
import { getBatchPerformance, type BatchPerformanceResponse, type PerformanceQueryParams } from '../api';

interface UseValidatorPerformanceReturn {
  data: BatchPerformanceResponse | null;
  isLoading: boolean;
  error: string | null;
  params: PerformanceQueryParams;
  setParams: (params: PerformanceQueryParams) => void;
  refetch: () => Promise<void>;
}

export function useValidatorPerformance(initialParams: PerformanceQueryParams = { minutes: 30 }): UseValidatorPerformanceReturn {
  const [data, setData] = useState<BatchPerformanceResponse | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [params, setParams] = useState<PerformanceQueryParams>(initialParams);

  const fetchData = useCallback(async (queryParams: PerformanceQueryParams) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await getBatchPerformance(queryParams);
      setData(response);
    } catch (err: any) {
      setError(err.message || 'An unexpected error occurred while fetching data');
      setData(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData(params);
  }, [params, fetchData]);

  const refetch = useCallback(() => {
    return fetchData(params);
  }, [params, fetchData]);

  return {
    data,
    isLoading,
    error,
    params,
    setParams,
    refetch
  };
}
