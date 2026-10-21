import { keepPreviousData, QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App } from 'antd';
import { useTranslation } from 'react-i18next';
import type {
  AccountDto,
  AppConfig,
  AuditDto,
  BillDto,
  BillOccurrenceDto,
  CardDto,
  CategoryDto,
  ChartDto,
  DashboardDto,
  FxDto,
  InstitutionDto,
  InvestDto,
  MeDto,
  NotifyDto,
  PasskeyDto,
  PriceAlertDto,
  ReminderDto,
  SessionDto,
  StatementDto,
  StatsDto,
  TagDto,
  TransactionListDto,
  WatchItemDto,
} from '@z-ui/shared';
import { ApiError, get, qs } from './client.ts';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Fewer refetches = fewer Worker requests / D1 reads on Cloudflare's free plan.
      staleTime: 60_000,
      refetchOnWindowFocus: true,
      retry: (n, e) => !(e instanceof ApiError && e.status >= 400 && e.status < 500) && n < 2,
    },
  },
});

export const useMe = () =>
  useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await get<MeDto>('/auth/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });

export const useConfig = () => useQuery({ queryKey: ['config'], queryFn: () => get<AppConfig>('/config'), staleTime: 300_000 });
export const useDashboard = (currency?: string) =>
  useQuery({ queryKey: ['dashboard', currency ?? ''], queryFn: () => get<DashboardDto>(`/dashboard${qs({ currency })}`), placeholderData: keepPreviousData });
export const useInstitutions = () => useQuery({ queryKey: ['institutions'], queryFn: () => get<InstitutionDto[]>('/institutions') });
export const useAccounts = () => useQuery({ queryKey: ['accounts'], queryFn: () => get<AccountDto[]>('/accounts') });
export const useCards = () => useQuery({ queryKey: ['cards'], queryFn: () => get<CardDto[]>('/cards') });
export const useCategories = () => useQuery({ queryKey: ['categories'], queryFn: () => get<CategoryDto[]>('/categories') });
export const useTags = () => useQuery({ queryKey: ['tags'], queryFn: () => get<TagDto[]>('/tags') });
export const useBills = () => useQuery({ queryKey: ['bills'], queryFn: () => get<BillDto[]>('/bills') });
export const useStatements = () => useQuery({ queryKey: ['statements'], queryFn: () => get<StatementDto[]>('/statements') });
export const useReminders = () =>
  useQuery({ queryKey: ['reminders'], queryFn: () => get<ReminderDto[]>('/reminders'), refetchInterval: 5 * 60_000 });

/** Without a range: the full history plus ~2 months ahead. */
export const useOccurrences = (from?: string, to?: string) =>
  useQuery({ queryKey: ['occurrences', from ?? '', to ?? ''], queryFn: () => get<BillOccurrenceDto[]>(`/bills/occurrences${qs({ from, to })}`) });

export const useStats = (q: { from: string; to: string; currency?: string; convertTo?: string; institutionId?: string; invest?: '0' }) =>
  useQuery({ queryKey: ['stats', q], queryFn: () => get<StatsDto>(`/stats${qs(q)}`), placeholderData: keepPreviousData });

export interface TxFilters {
  accountId?: string;
  institutionId?: string;
  cardId?: string;
  type?: string;
  categoryId?: string;
  tagId?: string;
  from?: string;
  to?: string;
  q?: string;
  currency?: string;
  /** '1': include transactions tagged hidden. */
  hidden?: '1';
  /** '1': include stock-trade cash legs. */
  trades?: '1';
  page?: number;
  pageSize?: number;
}

export const useTransactions = (f: TxFilters, enabled = true) =>
  useQuery({
    queryKey: ['transactions', f],
    queryFn: () => get<TransactionListDto>(`/transactions${qs({ ...f })}`),
    placeholderData: keepPreviousData,
    enabled,
  });

export const usePasskeys = () => useQuery({ queryKey: ['passkeys'], queryFn: () => get<PasskeyDto[]>('/auth/passkeys') });
export const useSessions = () => useQuery({ queryKey: ['sessions'], queryFn: () => get<SessionDto[]>('/auth/sessions') });
export const useAudit = () => useQuery({ queryKey: ['audit'], queryFn: () => get<AuditDto[]>('/auth/audit') });
export const useFx = () => useQuery({ queryKey: ['fx'], queryFn: () => get<FxDto>('/fx') });
export const useInvest = () => useQuery({ queryKey: ['invest'], queryFn: () => get<InvestDto>('/invest') });
export const useWatchlist = () => useQuery({ queryKey: ['watch'], queryFn: () => get<WatchItemDto[]>('/watch') });
export const useChart = (symbol: string | null) =>
  useQuery({ queryKey: ['chart', symbol], queryFn: () => get<ChartDto>(`/watch/chart/${symbol}`), enabled: !!symbol, staleTime: 300_000 });
export const useAlerts = () => useQuery({ queryKey: ['alerts'], queryFn: () => get<PriceAlertDto[]>('/watch/alerts') });
export const useNotify = () => useQuery({ queryKey: ['notify'], queryFn: () => get<NotifyDto>('/notify') });

export const useRecoveryCount = () =>
  useQuery({ queryKey: ['recovery'], queryFn: () => get<{ remaining: number }>('/auth/recovery-codes') });

/** Ledger data is interconnected (balances, dashboard, reminders), so mutations refresh it all. */
export function invalidateLedger(qc: QueryClient) {
  return qc.invalidateQueries({ predicate: (q) => !['me', 'config', 'passkeys', 'sessions', 'audit', 'bin', 'bin-meta', 'chart', 'notify'].includes(q.queryKey[0] as string) });
}

/** Mutation with toast feedback and ledger refresh. */
export function useAction<TVars, TRes = unknown>(fn: (v: TVars) => Promise<TRes>, opts: { success?: string | false; invalidate?: 'ledger' | string[] } = {}) {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const { t } = useTranslation();
  return useMutation({
    mutationFn: fn,
    onSuccess: async () => {
      if (opts.invalidate === undefined || opts.invalidate === 'ledger') await invalidateLedger(qc);
      else await Promise.all(opts.invalidate.map((k) => qc.invalidateQueries({ queryKey: [k] })));
      if (opts.success !== false) void message.success(opts.success ?? t('common.saved'));
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'STEP_UP_REQUIRED') return; // user cancelled the dialog
      void message.error(errorText(e, t));
    },
  });
}

export function errorText(e: unknown, t: (k: string) => string): string {
  if (e instanceof ApiError) {
    if (e.code === 'NETWORK') return t('errors.network');
    // Known error codes have a translated message; others show the server's text.
    const key = `errors.codes.${e.code}`;
    const translated = e.code ? t(key) : key;
    if (translated !== key) return translated;
    if (e.code === 'VALIDATION' && Array.isArray(e.details)) {
      const first = e.details[0] as { path?: (string | number)[]; message?: string } | undefined;
      if (first) return `${first.path?.join('.') ?? ''} ${first.message ?? ''}`.trim();
    }
    return e.message;
  }
  return (e as Error)?.message ?? t('errors.generic');
}
