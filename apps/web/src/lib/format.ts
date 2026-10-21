import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { BRAND_META, currencyDecimals, formatMoney, type AccountDto, type CardDto, type FormatMoneyOptions } from '@z-ui/shared';
import { useAccounts, useCards, useCategories, useConfig, useFx, useInstitutions, useTags } from '../api/hooks.ts';

export function useLocale() {
  const { i18n } = useTranslation();
  return i18n.language === 'en' ? 'en-US' : 'zh-CN';
}

export function useDecimals() {
  const { data: cfg } = useConfig();
  return useCallback((currency: string) => currencyDecimals(cfg ?? { currencies: [] }, currency), [cfg]);
}

/**
 * Convert minor units between currencies with the last synced FX rates (USD based), for the
 * "left blank → current rate" estimates. null when a rate is missing.
 */
export function useFxConvert() {
  const { data } = useFx();
  const decimals = useDecimals();
  return useCallback(
    (minor: number, from: string, to: string): number | null => {
      if (from === to) return minor;
      const perUsd = (c: string) => (c === 'USD' ? 1 : data?.rates.find((r) => r.currency === c)?.perUsd);
      const a = perUsd(from);
      const b = perUsd(to);
      if (!a || !b) return null;
      return Math.round((minor / 10 ** decimals(from) / a) * b * 10 ** decimals(to));
    },
    [data, decimals],
  );
}

/** (minor, currency) → localized string with the currency's own decimals and configured symbol. */
export function useMoney() {
  const { data: cfg } = useConfig();
  const decimals = useDecimals();
  const locale = useLocale();
  return useCallback(
    (minor: number, currency: string, opts: FormatMoneyOptions = {}) =>
      formatMoney(minor, currency, decimals(currency), {
        locale,
        symbol: cfg?.currencies.find((c) => c.code === currency)?.symbol,
        ...opts,
      }),
    [cfg, decimals, locale],
  );
}

export function useCountry() {
  const { data: cfg } = useConfig();
  return useCallback(
    (code: string) => {
      const c = cfg?.countries.find((x) => x.code === code);
      return { flag: c?.flag ?? '🏳️', name: c?.name ?? code };
    },
    [cfg],
  );
}

/** Id → entity maps for rendering labels in lists. */
export function useLookups() {
  const { data: institutions = [] } = useInstitutions();
  const { data: accounts = [] } = useAccounts();
  const { data: cards = [] } = useCards();
  const { data: categories = [] } = useCategories();
  const { data: tags = [] } = useTags();
  return useMemo(() => {
    const inst = new Map(institutions.map((x) => [x.id, x]));
    const acc = new Map(accounts.map((x) => [x.id, x]));
    const card = new Map(cards.map((x) => [x.id, x]));
    const cat = new Map(categories.map((x) => [x.id, x]));
    const tag = new Map(tags.map((x) => [x.id, x]));
    const accountLabel = (id: string | null | undefined) => {
      const a = id ? acc.get(id) : undefined;
      if (!a) return '';
      const i = inst.get(a.institutionId);
      return i ? `${i.name} · ${a.name}` : a.name;
    };
    return { institutions, accounts, cards, categories, tags, inst, acc, card, cat, tag, accountLabel };
  }, [institutions, accounts, cards, categories, tags]);
}

/**
 * Balances worth showing: currencies with a non-zero balance. An account whose balances are all
 * zero shows its primary currency (0); an account paying for stock trades always shows USD.
 */
export function visibleBalances<C extends { currency: string; balance: number }>(a: { currency: string; currencies: C[]; stockCash?: boolean }): C[] {
  const shown = a.currencies.filter((c) => c.balance !== 0 || (a.stockCash && c.currency === 'USD'));
  if (shown.length) return shown;
  return a.currencies.filter((c) => c.currency === a.currency).slice(0, 1);
}

export const cardLabel = (c: Pick<CardDto, 'nickname' | 'brand' | 'last4'>) => `${c.nickname ?? BRAND_META[c.brand].label} •••• ${c.last4}`;

/** Account <Select> options grouped by institution. */
export function useAccountOptions(filter?: (a: AccountDto) => boolean) {
  const { institutions, accounts } = useLookups();
  return useMemo(
    () =>
      institutions
        .map((i) => ({
          label: i.name,
          title: i.name,
          options: accounts
            .filter((a) => a.institutionId === i.id && !a.archived && (!filter || filter(a)))
            .map((a) => ({ value: a.id, label: `${a.name} · ${a.currencies.map((c) => c.currency).join('/')}` })),
        }))
        .filter((g) => g.options.length > 0),
    [institutions, accounts, filter],
  );
}

export function initials(name: string) {
  const s = name.trim();
  if (!s) return '?';
  // Latin names get two letters ("HS"), CJK names one character.
  return /^[a-z0-9]/i.test(s) ? s.slice(0, 2).toUpperCase() : s.slice(0, 1);
}

/** Stable pleasant color for an avatar when none is set. */
export function colorFor(seed: string) {
  const palette = ['#1677ff', '#722ed1', '#13c2c2', '#eb2f96', '#fa8c16', '#52c41a', '#2f54eb', '#faad14', '#08979c', '#f5222d'];
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return palette[h % palette.length]!;
}

/**
 * Currency picked for the overview's converted total, shared with the statistics (per browser).
 * Unset = the configured summary currency.
 */
const SUMMARY_KEY = 'zui-summary-currency';
export function readSummaryCurrency(): string | undefined {
  try {
    return localStorage.getItem(SUMMARY_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}
export function writeSummaryCurrency(code: string) {
  try {
    localStorage.setItem(SUMMARY_KEY, code);
  } catch {
    /* private mode: this visit only */
  }
}
