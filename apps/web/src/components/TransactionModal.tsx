import { DeleteOutlined } from '@ant-design/icons';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Checkbox, DatePicker, Form, Input, Modal, Popconfirm, Segmented, Select, Space, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import { fromMinor, HIDDEN_TAG, type AccountDto, type TagDto, type TransactionDto, type TransactionType } from '@z-ui/shared';
import { del, get, post, put } from '../api/client.ts';
import { errorText, invalidateLedger, useConfig } from '../api/hooks.ts';
import { cardLabel, useAccountOptions, useDecimals, useFxConvert, useFxLossText, useFxRate, useLookups, useMoney } from '../lib/format.ts';
import { CustomFieldInputs } from './CustomFields.tsx';
import { MoneyInput } from './Money.tsx';

interface Values {
  type: TransactionType;
  accountId?: string;
  currency?: string;
  cardId?: string | null;
  fromAccountId?: string;
  fromCurrency?: string;
  toAccountId?: string;
  toCurrency?: string;
  amount?: number | null;
  toAmount?: number | null;
  /** Transfers: fee charged on top by the source account (booked as its own expense). */
  fee?: number | null;
  /** Charged in another currency than the account's (e.g. USD from a CNY-only wallet). */
  foreign?: boolean;
  originalCurrency?: string;
  originalAmount?: number | null;
  categoryId?: string | null;
  counterparty?: string;
  note?: string;
  occurredAt: Dayjs;
  tagIds?: string[];
  extra?: Record<string, unknown>;
}

export interface TxDefaults {
  type?: TransactionType;
  accountId?: string;
  cardId?: string;
}

function initialValues(tx: TransactionDto | null | undefined, d: TxDefaults): Partial<Values> {
  if (!tx) return { type: d.type ?? 'expense', accountId: d.accountId, cardId: d.cardId, occurredAt: dayjs(), tagIds: [], extra: {} };
  const common = { occurredAt: dayjs(tx.occurredAt), note: tx.note ?? undefined, counterparty: tx.counterparty ?? undefined, tagIds: tx.tagIds, extra: tx.extra, categoryId: tx.categoryId };
  if (tx.type === 'transfer') {
    const out = tx.amount < 0;
    const other = { accountId: tx.counterpartAccountId ?? undefined, currency: tx.counterpartCurrency ?? undefined, amount: tx.counterpartAmount ?? 0 };
    return {
      ...common,
      type: 'transfer',
      fromAccountId: out ? tx.accountId : other.accountId,
      fromCurrency: out ? tx.currency : other.currency,
      toAccountId: out ? other.accountId : tx.accountId,
      toCurrency: out ? other.currency : tx.currency,
      amount: out ? -tx.amount : -other.amount,
      toAmount: out ? other.amount : tx.amount,
      fee: tx.fee,
    };
  }
  return {
    ...common,
    type: tx.type,
    accountId: tx.accountId,
    currency: tx.currency,
    cardId: tx.cardId,
    amount: tx.type === 'adjustment' ? tx.amount : Math.abs(tx.amount),
    foreign: !!tx.originalCurrency,
    originalCurrency: tx.originalCurrency ?? undefined,
    originalAmount: tx.originalAmount,
  };
}

/** Currency picker shown only for multi-currency accounts. */
function CurrencyPick({ account, value, onChange }: { account?: AccountDto; value?: string; onChange?: (v: string) => void }) {
  if (!account || account.currencies.length < 2) return null;
  return (
    <Select
      style={{ width: 96, flex: '0 0 auto' }}
      value={value ?? account.currency}
      onChange={onChange}
      options={account.currencies.map((c) => ({ value: c.currency, label: c.currency }))}
    />
  );
}

interface ModalProps {
  open: boolean;
  onClose: () => void;
  editing?: TransactionDto | null;
  defaults?: TxDefaults;
}

/** A transfer's fee row opens the transfer it belongs to. */
export function TransactionModal(props: ModalProps) {
  const parentId = props.editing?.feeParentId ?? null;
  const { data: parent } = useQuery({
    queryKey: ['transaction', parentId],
    queryFn: () => get<TransactionDto>(`/transactions/${parentId}`),
    enabled: props.open && !!parentId,
  });
  if (!parentId) return <TransactionForm {...props} />;
  return <TransactionForm {...props} open={props.open && !!parent} editing={parent ?? null} />;
}

function TransactionForm({ open, onClose, editing, defaults = {} }: ModalProps) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();
  const [busy, setBusy] = useState(false);
  const L = useLookups();
  const navigate = useNavigate();
  const decimals = useDecimals();
  const accountOptions = useAccountOptions();
  const fx = useFxConvert();
  const marketRate = useFxRate();
  const lossText = useFxLossText();
  const money = useMoney();
  const { data: cfg } = useConfig();

  const type = Form.useWatch('type', form) ?? 'expense';
  const accountId = Form.useWatch('accountId', form);
  const fromId = Form.useWatch('fromAccountId', form);
  const toId = Form.useWatch('toAccountId', form);
  const amount = Form.useWatch('amount', form);
  const toAmount = Form.useWatch('toAmount', form);
  const currencyField = Form.useWatch('currency', form);
  const fromCurField = Form.useWatch('fromCurrency', form);
  const toCurField = Form.useWatch('toCurrency', form);
  const foreignField = Form.useWatch('foreign', form);
  const originalCurrency = Form.useWatch('originalCurrency', form);
  const originalAmount = Form.useWatch('originalAmount', form);

  useEffect(() => {
    if (open) {
      form.resetFields();
      form.setFieldsValue(initialValues(editing, defaults) as Values);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing]);

  const account = accountId ? L.acc.get(accountId) : undefined;
  const from = fromId ? L.acc.get(fromId) : undefined;
  const to = toId ? L.acc.get(toId) : undefined;
  const currency = currencyField ?? account?.currency;
  const fromCurrency = fromCurField ?? from?.currency;
  const toCurrency = toCurField ?? to?.currency;
  const crossCurrency = !!fromCurrency && !!toCurrency && fromCurrency !== toCurrency;

  const cardOptions = useMemo(
    () => L.cards.filter((c) => c.accountId === accountId && !c.archived && c.status !== 'closed').map((c) => ({ value: c.id, label: cardLabel(c) })),
    [L.cards, accountId],
  );
  const categoryOptions = useMemo(
    () => L.categories.filter((c) => !c.archived && c.kind === (type === 'income' ? 'income' : 'expense')).map((c) => ({ value: c.id, label: c.name })),
    [L.categories, type],
  );
  const tagOptions = useMemo(() => L.tags.map((tg) => ({ value: tg.id, label: tg.name })), [L.tags]);
  const hiddenTag = L.tags.find((tg) => tg.name.toLowerCase() === HIDDEN_TAG);

  const rateOf = (paid: number, from: string, got: number, to: string) => (Number(fromMinor(got, decimals(to))) / Number(fromMinor(paid, decimals(from)))).toFixed(4);
  /** Market rate to judge the exchange by: the one recorded with the entry while its currencies are unchanged, else today's. */
  const refRate = (a: string, b: string) => {
    if (editing?.marketRate) {
      const init = initialValues(editing, {});
      const pair = init.type === 'transfer' ? [init.fromCurrency, init.toCurrency] : [init.originalCurrency, init.currency];
      if (pair[0] === a && pair[1] === b) return editing.marketRate;
    }
    return marketRate(a, b);
  };
  const withLoss = (text: string, loss: string | null) => (loss ? `${text} · ${loss}` : text);
  const rate = crossCurrency && amount && toAmount ? rateOf(amount, fromCurrency!, toAmount, toCurrency!) : null;
  const transferLoss =
    rate !== null ? lossText({ a: amount!, aCurrency: fromCurrency!, b: toAmount!, bCurrency: toCurrency!, rate: refRate(fromCurrency!, toCurrency!), paying: false }) : null;
  // Left blank, the received amount is converted at the current rate (shown as the placeholder).
  const toEstimate = crossCurrency && amount && !toAmount ? fx(amount, fromCurrency!, toCurrency!) : null;

  // Foreign-currency charge: the merchant's amount, and what the account actually paid.
  const foreign = !!foreignField && (type === 'expense' || type === 'income') && !!originalCurrency && originalCurrency !== currency;
  const foreignOn = !!foreignField && (type === 'expense' || type === 'income');
  const paidEstimate = foreign && originalAmount && currency ? fx(originalAmount, originalCurrency!, currency) : null;
  const foreignHint = !foreign
    ? undefined
    : amount && originalAmount
      ? withLoss(
          t('tx.rate', { from: originalCurrency, rate: rateOf(originalAmount, originalCurrency!, amount, currency!), to: currency }),
          lossText({ a: originalAmount, aCurrency: originalCurrency!, b: amount, bCurrency: currency!, rate: refRate(originalCurrency!, currency!), paying: type === 'expense' }),
        )
      : !originalAmount
        ? t('tx.paidHint')
        : paidEstimate !== null
          ? t('tx.autoRate', { amount: money(paidEstimate, currency!) })
          : t('tx.noRate', { from: originalCurrency, to: currency });
  const currencyOptions = useMemo(() => (cfg?.currencies ?? []).map((c) => ({ value: c.code, label: c.code, title: c.name })), [cfg]);
  const pickForeign = (on: boolean) => {
    if (on && !form.getFieldValue('originalCurrency')) {
      form.setFieldValue('originalCurrency', currency === 'USD' ? cfg?.currencies.find((c) => c.code !== 'USD')?.code : 'USD');
    }
  };

  const submit = async (v: Values) => {
    setBusy(true);
    try {
      // Tags typed in the select that don't exist yet are created first.
      const known = new Set(L.tags.map((x) => x.id));
      const tagIds: string[] = [];
      for (const id of v.tagIds ?? []) {
        if (known.has(id)) tagIds.push(id);
        else tagIds.push((await post<TagDto>('/tags', { name: id })).id);
      }
      const base = { occurredAt: v.occurredAt.format('YYYY-MM-DD'), note: v.note || null, counterparty: v.counterparty || null, tagIds, extra: v.extra ?? {} };
      const body =
        v.type === 'transfer'
          ? {
              ...base,
              type: 'transfer',
              fromAccountId: v.fromAccountId,
              fromCurrency,
              toAccountId: v.toAccountId,
              toCurrency,
              amount: v.amount,
              toAmount: crossCurrency ? (v.toAmount ?? null) : null,
              fee: v.fee || null,
            }
          : v.type === 'adjustment'
            ? { ...base, type: 'adjustment', accountId: v.accountId, currency, amount: v.amount }
            : {
                ...base,
                type: v.type,
                accountId: v.accountId,
                currency,
                cardId: v.cardId || null,
                categoryId: v.categoryId || null,
                amount: v.amount ?? null,
                originalCurrency: foreign ? originalCurrency : null,
                originalAmount: foreign ? v.originalAmount : null,
              };
      if (editing) await put(`/transactions/${editing.id}`, body);
      else await post('/transactions', body);
      await invalidateLedger(qc);
      void message.success(t('common.saved'));
      onClose();
    } catch (e) {
      void message.error(errorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!editing) return;
    try {
      await del(`/transactions/${editing.id}`);
      await invalidateLedger(qc);
      void message.success(t('common.deleted'));
      onClose();
    } catch (e) {
      void message.error(errorText(e, t));
    }
  };

  // Cash legs of stock trades belong to the trade; they are edited on the investments page.
  if (editing?.type === 'trade') {
    return (
      <Modal
        open={open}
        onCancel={onClose}
        title={t('tx.types.trade')}
        destroyOnHidden
        footer={
          <Space>
            <Button onClick={onClose}>{t('common.close')}</Button>
            <Button type="primary" onClick={() => (onClose(), navigate('/invest'))}>
              {t('nav.invest')}
            </Button>
          </Space>
        }
      >
        <Alert type="info" showIcon message={t('invest.tradeTx')} />
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onCancel={onClose}
      title={editing ? t('tx.edit') : t('tx.add')}
      destroyOnHidden
      width={520}
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>
            {editing && (
              <Popconfirm title={t('common.deleteConfirm')} description={editing.transferGroupId ? t('tx.deleteTransfer') : undefined} onConfirm={remove}>
                <Button danger icon={<DeleteOutlined />}>
                  {t('common.delete')}
                </Button>
              </Popconfirm>
            )}
          </span>
          <span style={{ display: 'flex', gap: 8 }}>
            <Button onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="primary" loading={busy} onClick={() => form.submit()}>
              {t('common.save')}
            </Button>
          </span>
        </div>
      }
    >
      <Form form={form} layout="vertical" requiredMark={false} onFinish={submit} style={{ marginTop: 12 }}>
        <Form.Item name="type" style={{ marginBottom: 16 }}>
          <Segmented block options={(['expense', 'income', 'transfer', 'adjustment'] as const).map((k) => ({ value: k, label: t(`tx.types.${k}`) }))} />
        </Form.Item>

        {type === 'transfer' ? (
          <>
            <Form.Item label={t('tx.from')} required htmlFor="fromAccountId">
              <Space.Compact block>
                <Form.Item name="fromAccountId" noStyle rules={[{ required: true }]}>
                  <Select options={accountOptions} showSearch={{ optionFilterProp: 'label' }} onChange={() => form.setFieldValue('fromCurrency', undefined)} />
                </Form.Item>
                <Form.Item name="fromCurrency" noStyle>
                  <CurrencyPick account={from} />
                </Form.Item>
              </Space.Compact>
            </Form.Item>
            <Form.Item label={t('tx.to')} required htmlFor="toAccountId">
              <Space.Compact block>
                <Form.Item
                  name="toAccountId"
                  noStyle
                  dependencies={['fromAccountId', 'fromCurrency', 'toCurrency']}
                  rules={[
                    { required: true },
                    // The same account is fine when exchanging between two of its currencies.
                    { validator: (_, v) => (v && v === fromId && fromCurrency === toCurrency ? Promise.reject(new Error('≠')) : Promise.resolve()) },
                  ]}
                >
                  <Select options={accountOptions} showSearch={{ optionFilterProp: 'label' }} onChange={() => form.setFieldValue('toCurrency', undefined)} />
                </Form.Item>
                <Form.Item name="toCurrency" noStyle>
                  <CurrencyPick account={to} />
                </Form.Item>
              </Space.Compact>
            </Form.Item>
            <Form.Item name="amount" label={t('common.amount')} rules={[{ required: true }]}>
              <MoneyInput currency={fromCurrency ?? '—'} autoFocus />
            </Form.Item>
            {crossCurrency && (
              <Form.Item
                name="toAmount"
                label={t('tx.toAmount')}
                extra={
                  rate
                    ? withLoss(t('tx.rate', { from: fromCurrency, rate, to: toCurrency }), transferLoss)
                    : !amount
                      ? t('tx.toAmountHint')
                      : toEstimate !== null
                        ? t('tx.autoRate', { amount: money(toEstimate, toCurrency!) })
                        : t('tx.noRate', { from: fromCurrency, to: toCurrency })
                }
              >
                <MoneyInput currency={toCurrency!} placeholder={toEstimate !== null ? fromMinor(toEstimate, decimals(toCurrency!)) : undefined} />
              </Form.Item>
            )}
            <Form.Item name="fee" label={t('tx.fee', { currency: fromCurrency ?? '' })} extra={t('tx.feeHint')}>
              <MoneyInput currency={fromCurrency ?? '—'} placeholder={t('common.optional')} />
            </Form.Item>
          </>
        ) : (
          <>
            <Form.Item name="accountId" label={t('tx.account')} rules={[{ required: true }]}>
              <Select
                options={accountOptions}
                showSearch={{ optionFilterProp: 'label' }}
                onChange={() => {
                  form.setFieldValue('cardId', null);
                  form.setFieldValue('currency', undefined);
                }}
              />
            </Form.Item>
            {type !== 'adjustment' && (
              <Form.Item name="foreign" valuePropName="checked" style={{ marginBottom: 8 }}>
                <Checkbox onChange={(e) => pickForeign(e.target.checked)}>{t('tx.foreign')}</Checkbox>
              </Form.Item>
            )}
            {foreignOn && (
              <Form.Item label={t('tx.originalAmount')} required htmlFor="originalAmount">
                <Space.Compact block>
                  <Form.Item name="originalCurrency" noStyle rules={[{ required: true }]}>
                    <Select style={{ width: 96, flex: '0 0 auto' }} options={currencyOptions} showSearch={{ optionFilterProp: 'label' }} />
                  </Form.Item>
                  <Form.Item name="originalAmount" noStyle rules={[{ required: true }]}>
                    <MoneyInput currency={originalCurrency ?? '—'} autoFocus />
                  </Form.Item>
                </Space.Compact>
              </Form.Item>
            )}
            <Form.Item
              label={foreign ? t('tx.paidAmount', { currency }) : t('common.amount')}
              required={!foreign}
              htmlFor="amount"
              extra={type === 'adjustment' ? t('tx.adjustmentHint') : foreignHint}
            >
              <Space.Compact block>
                <Form.Item name="currency" noStyle>
                  <CurrencyPick account={account} />
                </Form.Item>
                <Form.Item name="amount" noStyle rules={[{ required: !foreign }]}>
                  <MoneyInput
                    currency={currency ?? '—'}
                    allowNegative={type === 'adjustment'}
                    autoFocus={!foreignOn}
                    placeholder={paidEstimate !== null ? fromMinor(paidEstimate, decimals(currency!)) : undefined}
                  />
                </Form.Item>
              </Space.Compact>
            </Form.Item>
            {type !== 'adjustment' && (
              <>
                {cardOptions.length > 0 && (
                  <Form.Item name="cardId" label={t('tx.card')}>
                    <Select allowClear options={cardOptions} placeholder={t('common.optional')} />
                  </Form.Item>
                )}
                <Form.Item name="categoryId" label={t('tx.category')}>
                  <Select allowClear options={categoryOptions} showSearch={{ optionFilterProp: 'label' }} placeholder={t('common.optional')} />
                </Form.Item>
                <Form.Item name="counterparty" label={t('tx.counterparty')}>
                  <Input maxLength={128} />
                </Form.Item>
              </>
            )}
          </>
        )}

        <Form.Item name="occurredAt" label={t('common.date')} rules={[{ required: true }]}>
          <DatePicker style={{ width: '100%' }} allowClear={false} />
        </Form.Item>
        <Form.Item name="tagIds" label={t('tx.tags')} extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>{t('tx.tagsHint')}</Typography.Text>}>
          <Select mode="tags" options={tagOptions} showSearch={{ optionFilterProp: 'label' }} tokenSeparators={[',', '，']} />
        </Form.Item>
        {/* Shortcut for the "hidden" tag: small spending left out of the list, still in the stats. */}
        <Form.Item noStyle shouldUpdate={(a, b) => a.tagIds !== b.tagIds}>
          {() => {
            const ids: string[] = form.getFieldValue('tagIds') ?? [];
            const isHidden = (x: string) => x === hiddenTag?.id || x.toLowerCase() === HIDDEN_TAG;
            return (
              <Form.Item style={{ marginTop: -8 }}>
                <Checkbox
                  checked={ids.some(isHidden)}
                  onChange={(e) => form.setFieldValue('tagIds', e.target.checked ? [...ids, hiddenTag?.id ?? HIDDEN_TAG] : ids.filter((x) => !isHidden(x)))}
                >
                  {t('tx.markHidden')}
                </Checkbox>
              </Form.Item>
            );
          }}
        </Form.Item>
        <Form.Item name="note" label={t('common.note')}>
          <Input.TextArea autoSize={{ minRows: 1, maxRows: 4 }} maxLength={2000} />
        </Form.Item>
        <CustomFieldInputs entity="transaction" />
      </Form>
    </Modal>
  );
}
