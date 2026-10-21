import { DeleteOutlined, EditOutlined, FormOutlined, PlusOutlined, SyncOutlined, WarningOutlined } from '@ant-design/icons';
import { Alert, App, Button, Card, Col, Collapse, DatePicker, Empty, Form, Input, Modal, Popconfirm, Row, Segmented, Select, Space, Statistic, Table, Tabs, Tag, Tooltip } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router';
import { decimalToMinor, todayIso, type AccountDto, type HoldingDto, type PriceSyncDto, type QuoteProblem, type TradeDto } from '@z-ui/shared';
import { del, post, put } from '../api/client.ts';
import { useAction, useInvest } from '../api/hooks.ts';
import { MoneyInput, MoneyText } from '../components/Money.tsx';
import { WatchPanel } from '../components/Watchlist.tsx';
import { PageTop } from '../layouts/PanelLayout.tsx';
import { useAccountOptions, useLocale, useLookups, useMoney } from '../lib/format.ts';

const USD = 'USD';
const QTY = /^\d{1,12}(\.\d{1,6})?$/;
/** Prices are entered with at most two decimals (cents). */
const PRICE = /^\d{1,12}(\.\d{1,2})?$/;

/** "12.500000" → "12.5" (share quantities). */
const trimDec = (s: string) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
const holdsUsd = (a: AccountDto) => a.currencies.some((c) => c.currency === USD);
const isInvestment = (a: AccountDto) => a.type === 'investment' && holdsUsd(a);

/** Price / average cost (decimal string) → "$1,234.57": always two decimals. */
function useUsdPrice() {
  const money = useMoney();
  return (s: string | null) => (s === null ? '—' : money(decimalToMinor(s), USD));
}

interface TradeForm {
  side: 'buy' | 'sell';
  symbol: string;
  quantity: string;
  by: 'price' | 'amount';
  price?: string;
  amount?: number | null;
  fee?: number | null;
  tradeDate: Dayjs;
  accountId?: string;
  cashAccountId?: string | null;
  note?: string;
}

function TradeModal({ open, editing, onClose }: { open: boolean; editing: TradeDto | null; onClose: () => void }) {
  const { t } = useTranslation();
  const L = useLookups();
  const [form] = Form.useForm<TradeForm>();
  // Shares belong to an investment account; the money moves in any account holding USD.
  const investOptions = useAccountOptions(isInvestment);
  const cashOptions = useAccountOptions(holdsUsd);
  const by = Form.useWatch('by', form) ?? 'price';
  const legacy = editing?.accountId ? L.acc.get(editing.accountId) : undefined;
  const legacyNotInvestment = !!legacy && !isInvestment(legacy);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (editing) {
      // A price with more than two decimals came from a total amount: edit it by amount so the
      // stored amount stays exactly what was paid.
      const fine = PRICE.test(trimDec(editing.price));
      form.setFieldsValue({
        side: editing.side,
        symbol: editing.symbol,
        quantity: trimDec(editing.quantity),
        by: fine ? 'price' : 'amount',
        price: fine ? trimDec(editing.price) : undefined,
        amount: fine ? undefined : editing.amount,
        fee: editing.fee,
        tradeDate: dayjs(editing.tradeDate),
        accountId: legacyNotInvestment ? undefined : (editing.accountId ?? undefined),
        cashAccountId: editing.cashAccountId,
        note: editing.note ?? undefined,
      });
    } else {
      const only = L.accounts.filter((a) => !a.archived && isInvestment(a));
      form.setFieldsValue({ side: 'buy', by: 'price', tradeDate: dayjs(todayIso()), fee: 0, accountId: only.length === 1 ? only[0]!.id : undefined });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing]);

  const save = useAction(async (v: TradeForm) => {
    const body = {
      side: v.side,
      symbol: v.symbol,
      quantity: v.quantity,
      price: v.by === 'price' ? v.price : null,
      amount: v.by === 'amount' ? v.amount : null,
      fee: v.fee ?? 0,
      tradeDate: v.tradeDate.format('YYYY-MM-DD'),
      accountId: v.accountId,
      cashAccountId: v.cashAccountId ?? null,
      note: v.note || null,
    };
    if (editing) await put(`/invest/trades/${editing.id}`, body);
    else await post('/invest/trades', body);
    onClose();
  });

  return (
    <Modal
      open={open}
      title={editing ? t('invest.editTrade') : t('invest.addTrade')}
      onCancel={onClose}
      onOk={() => form.submit()}
      confirmLoading={save.isPending}
      destroyOnHidden
      width={520}
    >
      {investOptions.length === 0 && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={t('invest.needInvestAccount')}
          action={
            <Link to="/accounts" onClick={onClose}>
              {t('nav.accounts')}
            </Link>
          }
        />
      )}
      {legacyNotInvestment && <Alert type="info" showIcon style={{ marginBottom: 12 }} message={t('invest.legacyAccount', { name: L.accountLabel(legacy.id) })} />}
      <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)} requiredMark={false}>
        <Form.Item name="side">
          <Segmented
            block
            options={[
              { value: 'buy', label: t('invest.buy') },
              { value: 'sell', label: t('invest.sell') },
            ]}
          />
        </Form.Item>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="symbol" label={t('invest.symbol')} rules={[{ required: true, pattern: /^[A-Za-z][A-Za-z0-9.-]{0,9}$/ }]} normalize={(v: string) => v?.toUpperCase()}>
              <Input placeholder="AAPL" autoFocus={!editing} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="quantity" label={t('invest.quantity')} rules={[{ required: true }, { pattern: QTY, message: t('invest.decimalHint') }]}>
              <Input inputMode="decimal" placeholder="10" />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="by" extra={t('invest.priceOrAmount')}>
          <Segmented
            options={[
              { value: 'price', label: t('invest.byPrice') },
              { value: 'amount', label: t('invest.byAmount') },
            ]}
          />
        </Form.Item>
        <Row gutter={12}>
          <Col span={12}>
            {by === 'price' ? (
              <Form.Item name="price" label={t('invest.price')} rules={[{ required: true }, { pattern: PRICE, message: t('invest.price2Hint') }]}>
                <Input inputMode="decimal" prefix="$" />
              </Form.Item>
            ) : (
              <Form.Item name="amount" label={t('invest.amount')} rules={[{ required: true }]}>
                <MoneyInput currency={USD} />
              </Form.Item>
            )}
          </Col>
          <Col span={12}>
            <Form.Item name="fee" label={t('invest.fee')}>
              <MoneyInput currency={USD} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="tradeDate" label={t('invest.tradeDate')} rules={[{ required: true }]}>
          <DatePicker style={{ width: '100%' }} allowClear={false} />
        </Form.Item>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="accountId" label={t('invest.account')} tooltip={t('invest.accountHint')} rules={[{ required: true }]}>
              <Select options={investOptions} showSearch={{ optionFilterProp: 'label' }} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="cashAccountId" label={t('invest.cashAccount')} tooltip={t('invest.cashAccountHint')}>
              <Select allowClear options={cashOptions} placeholder={t('invest.noCash')} showSearch={{ optionFilterProp: 'label' }} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="note" label={t('common.note')}>
          <Input.TextArea autoSize={{ minRows: 1, maxRows: 4 }} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function PriceModal({ symbol, current, onClose, onDone }: { symbol: string | null; current: string | null; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [form] = Form.useForm<{ price: string }>();
  useEffect(() => {
    if (symbol) form.setFieldsValue({ price: current ? (decimalToMinor(current) / 100).toFixed(2) : '' });
  }, [symbol, current, form]);
  const save = useAction(async (v: { price: string }) => {
    await put(`/invest/prices/${symbol}`, v);
    onDone();
  });
  return (
    <Modal open={!!symbol} title={`${t('invest.setPrice')} · ${symbol ?? ''}`} onCancel={onClose} onOk={() => form.submit()} confirmLoading={save.isPending} destroyOnHidden width={360}>
      <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
        <Form.Item name="price" rules={[{ required: true, pattern: PRICE, message: t('invest.price2Hint') }]}>
          <Input inputMode="decimal" prefix="$" autoFocus />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function RenameModal({ symbol, suggestion, onClose, onDone }: { symbol: string | null; suggestion?: string | null; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [form] = Form.useForm<{ to: string }>();
  useEffect(() => {
    if (symbol) form.setFieldsValue({ to: suggestion ?? symbol });
  }, [symbol, suggestion, form]);
  const save = useAction(async (v: { to: string }) => {
    await post(`/invest/symbols/${symbol}/rename`, v);
    onDone();
  });
  return (
    <Modal open={!!symbol} title={`${t('invest.rename')} · ${symbol ?? ''}`} onCancel={onClose} onOk={() => form.submit()} confirmLoading={save.isPending} destroyOnHidden width={380}>
      <p className="muted">{t('invest.renameHint', { symbol })}</p>
      <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
        <Form.Item name="to" label={t('invest.renameTo')} rules={[{ required: true, pattern: /^[A-Za-z][A-Za-z0-9.-]{0,9}$/ }]} normalize={(v: string) => v?.toUpperCase()}>
          <Input autoFocus />
        </Form.Item>
      </Form>
    </Modal>
  );
}

export function InvestPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const L = useLookups();
  const money = useMoney();
  const usdPrice = useUsdPrice();
  const locale = useLocale();
  const { data, isLoading } = useInvest();
  const [modal, setModal] = useState<{ open: boolean; editing: TradeDto | null }>({ open: false, editing: null });
  const [pricing, setPricing] = useState<HoldingDto | null>(null);
  const [renaming, setRenaming] = useState<{ symbol: string; suggestion?: string | null } | null>(null);
  // Symbols the last sync could not price (cleared when they get a price or are renamed).
  const [problems, setProblems] = useState<QuoteProblem[]>([]);
  // ?tab=watch&symbol=AAPL: the watchlist tab and the chart shown.
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'watch' ? 'watch' : 'holdings';
  const watchSymbol = params.get('symbol');
  const go = (next: { tab?: string; symbol?: string | null }) => {
    const p = new URLSearchParams(params);
    if (next.tab !== undefined) p.set('tab', next.tab);
    if (next.symbol !== undefined) {
      if (next.symbol) p.set('symbol', next.symbol);
      else p.delete('symbol');
    }
    setParams(p, { replace: true });
  };

  const sync = useAction(() => post<PriceSyncDto>('/invest/prices/sync'), { success: false, invalidate: ['invest', 'dashboard', 'accounts'] });
  const remove = useAction((id: string) => del(`/invest/trades/${id}`), { success: t('common.deleted') });

  const usd = (n: number | null, signed = false) => (n === null ? '—' : money(n, USD, { signDisplay: signed ? 'exceptZero' : 'auto' }));
  const pl = (n: number | null) => (n === null ? <span className="muted">—</span> : <span className={`num ${n > 0 ? 'income' : n < 0 ? 'expense' : ''}`}>{usd(n, true)}</span>);
  const pct = (n: number | null, base: number) => (n === null || !base ? '' : ` (${n > 0 ? '+' : ''}${((n / base) * 100).toFixed(2)}%)`);

  const totals = data?.totals ?? { marketValue: 0, costBasis: 0, unrealized: 0, realized: 0 };
  const held = useMemo(() => new Set((data?.holdings ?? []).map((h) => h.symbol)), [data]);
  const shownProblems = problems.filter((p) => held.has(p.symbol));
  const resolved = (symbol: string | undefined) => setProblems((list) => list.filter((p) => p.symbol !== symbol));

  const accountCell = (id: string | null) => {
    const a = id ? L.acc.get(id) : undefined;
    if (!a) return <span className="muted">—</span>;
    return (
      <span className="muted">
        {L.accountLabel(a.id)}{' '}
        {!isInvestment(a) && (
          <Tooltip title={t('invest.notInvestment')}>
            <WarningOutlined style={{ color: 'var(--ant-color-warning)' }} />
          </Tooltip>
        )}
      </span>
    );
  };

  const holdingCols = [
    {
      title: t('invest.symbol'),
      key: 'symbol',
      render: (_: unknown, h: HoldingDto) => (
        <div>
          <Tooltip title={t('watch.openChart')}>
            <Button type="link" size="small" style={{ padding: 0, height: 'auto', fontWeight: 600 }} onClick={() => go({ tab: 'watch', symbol: h.symbol })}>
              {h.symbol}
            </Button>
          </Tooltip>
          {h.name && <div className="muted" style={{ fontSize: 12 }}>{h.name}</div>}
        </div>
      ),
    },
    { title: t('invest.account'), key: 'acc', responsive: ['lg' as const], render: (_: unknown, h: HoldingDto) => accountCell(h.accountId) },
    { title: t('invest.quantity'), dataIndex: 'quantity', align: 'right' as const, render: (v: string) => <span className="num">{trimDec(v)}</span> },
    { title: t('invest.avgCost'), dataIndex: 'avgCost', align: 'right' as const, responsive: ['md' as const], render: (v: string) => <span className="num">{usdPrice(v)}</span> },
    {
      title: t('invest.lastPrice'),
      key: 'price',
      align: 'right' as const,
      render: (_: unknown, h: HoldingDto) => (
        <Tooltip title={h.priceAt ? `${t('invest.priceAt')} ${new Date(h.priceAt).toLocaleString(locale)}` : t('invest.setPrice')}>
          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => setPricing(h)}>
            <span className="num">{usdPrice(h.price)}</span>
          </Button>
        </Tooltip>
      ),
    },
    { title: t('invest.costBasis'), dataIndex: 'costBasis', align: 'right' as const, responsive: ['md' as const], render: (v: number) => <span className="num">{usd(v)}</span> },
    { title: t('invest.marketValue'), dataIndex: 'marketValue', align: 'right' as const, render: (v: number | null) => <span className="num">{usd(v)}</span> },
    {
      title: t('invest.unrealized'),
      key: 'unrealized',
      align: 'right' as const,
      render: (_: unknown, h: HoldingDto) => (
        <span>
          {pl(h.unrealized)}
          <span className="muted num" style={{ fontSize: 12 }}>
            {pct(h.unrealized, h.costBasis)}
          </span>
        </span>
      ),
    },
    { title: t('invest.realized'), dataIndex: 'realized', align: 'right' as const, responsive: ['lg' as const], render: (v: number) => pl(v) },
    {
      title: '',
      key: 'actions',
      width: 44,
      render: (_: unknown, h: HoldingDto) => (
        <Tooltip title={t('invest.rename')}>
          <Button type="text" size="small" icon={<FormOutlined />} aria-label={t('invest.rename')} onClick={() => setRenaming({ symbol: h.symbol })} />
        </Tooltip>
      ),
    },
  ];

  return (
    <>
      <PageTop
        title={t('invest.title')}
        extra={
          tab === 'holdings' && (
          <Space>
            <Button
              icon={<SyncOutlined spin={sync.isPending} />}
              disabled={!data?.holdings.length}
              loading={sync.isPending}
              onClick={() =>
                sync.mutate(undefined, {
                  onSuccess: (r) => {
                    setProblems(r.failed);
                    if (r.updated || !r.failed.length) void message.success(t('invest.synced', { n: r.updated }));
                    if (r.remaining) void message.info(t('invest.syncMore', { n: r.remaining }));
                  },
                })
              }
            >
              {t('invest.syncPrices')}
            </Button>
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setModal({ open: true, editing: null })}>
              {t('invest.addTrade')}
            </Button>
          </Space>
          )
        }
      />

      <Tabs
        activeKey={tab}
        onChange={(k) => go({ tab: k })}
        items={[
          { key: 'holdings', label: t('watch.tabHoldings') },
          { key: 'watch', label: t('watch.tabWatch') },
        ]}
      />
      {tab === 'watch' ? (
        <WatchPanel symbol={watchSymbol} onSymbol={(s) => go({ symbol: s })} held={held} />
      ) : (
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {shownProblems.length > 0 && (
          <Alert
            type="warning"
            showIcon
            closable
            onClose={() => setProblems([])}
            message={t('invest.syncProblems')}
            description={
              <div className="quote-problems">
                {shownProblems.map((p) => (
                  <div key={p.symbol} className="quote-problem">
                    <b>{p.symbol}</b>
                    <span className="muted">{p.reason === 'not_found' ? t('invest.notFound') : t('invest.tempError')}</span>
                    <Space size={4} wrap>
                      {p.suggestion && (
                        <Button size="small" type="primary" onClick={() => setRenaming({ symbol: p.symbol, suggestion: p.suggestion })}>
                          {t('invest.useSuggestion', { symbol: p.suggestion })}
                        </Button>
                      )}
                      {p.reason === 'not_found' && !p.suggestion && (
                        <Button size="small" onClick={() => setRenaming({ symbol: p.symbol })}>
                          {t('invest.rename')}
                        </Button>
                      )}
                      <Button size="small" onClick={() => setPricing(data?.holdings.find((h) => h.symbol === p.symbol) ?? null)}>
                        {t('invest.setPrice')}
                      </Button>
                    </Space>
                  </div>
                ))}
              </div>
            }
          />
        )}

        <Row gutter={[16, 16]}>
          {[
            { k: 'marketValue', v: usd(totals.marketValue) },
            { k: 'costBasis', v: usd(totals.costBasis) },
            { k: 'unrealized', v: usd(totals.unrealized, true) + pct(totals.unrealized, totals.costBasis), cls: totals.unrealized > 0 ? 'income' : totals.unrealized < 0 ? 'expense' : '' },
            { k: 'realized', v: usd(totals.realized, true), cls: totals.realized > 0 ? 'income' : totals.realized < 0 ? 'expense' : '' },
          ].map((x) => (
            <Col xs={12} md={6} key={x.k}>
              <Card className="stat-tile">
                <Statistic title={t(`invest.${x.k}`)} value={x.v} valueStyle={{ fontVariantNumeric: 'tabular-nums', color: x.cls ? `var(--${x.cls})` : undefined }} />
              </Card>
            </Col>
          ))}
        </Row>

        <Card title={t('invest.holdings')}>
          <Table<HoldingDto>
            rowKey={(h) => `${h.accountId ?? ''}|${h.symbol}`}
            size="middle"
            loading={isLoading}
            pagination={false}
            dataSource={data?.holdings ?? []}
            columns={holdingCols}
            scroll={{ x: 'max-content' }}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('invest.noHoldings')} /> }}
          />
        </Card>

        {(data?.closed.length ?? 0) > 0 && (
          <Collapse
            items={[
              {
                key: 'closed',
                label: `${t('invest.closed')} (${data!.closed.length})`,
                children: (
                  <Table<HoldingDto>
                    rowKey={(h) => `${h.accountId ?? ''}|${h.symbol}`}
                    size="small"
                    pagination={false}
                    dataSource={data!.closed}
                    columns={[
                      { title: t('invest.symbol'), dataIndex: 'symbol', render: (v: string) => <b>{v}</b> },
                      { title: t('invest.account'), key: 'acc', render: (_, h) => accountCell(h.accountId) },
                      { title: t('invest.realized'), dataIndex: 'realized', align: 'right', render: (v: number) => pl(v) },
                    ]}
                  />
                ),
              },
            ]}
          />
        )}

        <Card title={t('invest.trades')}>
          <Table<TradeDto>
            rowKey="id"
            size="small"
            loading={isLoading}
            dataSource={data?.trades ?? []}
            pagination={{ pageSize: 20, hideOnSinglePage: true }}
            scroll={{ x: 'max-content' }}
            columns={[
              { title: t('invest.tradeDate'), dataIndex: 'tradeDate', render: (v: string) => <span className="num">{v}</span> },
              { title: '', dataIndex: 'side', render: (v: string) => <Tag color={v === 'buy' ? 'blue' : 'orange'}>{t(`invest.${v}`)}</Tag> },
              { title: t('invest.symbol'), dataIndex: 'symbol', render: (v: string) => <b>{v}</b> },
              { title: t('invest.quantity'), dataIndex: 'quantity', align: 'right', render: (v: string) => <span className="num">{trimDec(v)}</span> },
              { title: t('invest.price'), dataIndex: 'price', align: 'right', render: (v: string) => <span className="num">{usdPrice(v)}</span> },
              { title: t('invest.amount'), dataIndex: 'amount', align: 'right', render: (v: number) => <MoneyText minor={v} currency={USD} /> },
              { title: t('invest.fee'), dataIndex: 'fee', align: 'right', responsive: ['md'], render: (v: number) => (v ? <MoneyText minor={v} currency={USD} /> : <span className="muted">—</span>) },
              { title: t('invest.account'), key: 'acc', responsive: ['lg'], render: (_, tr) => accountCell(tr.accountId) },
              {
                title: t('invest.cashAccount'),
                key: 'cash',
                responsive: ['xl'],
                render: (_, tr) => (tr.cashAccountId ? <span className="muted">{L.accountLabel(tr.cashAccountId)}</span> : <span className="muted">—</span>),
              },
              {
                title: t('common.actions'),
                key: 'actions',
                width: 88,
                render: (_, tr) => (
                  <Space size={0}>
                    <Button type="text" size="small" icon={<EditOutlined />} aria-label={t('common.edit')} onClick={() => setModal({ open: true, editing: tr })} />
                    <Popconfirm title={t('common.deleteConfirm')} onConfirm={() => remove.mutate(tr.id)}>
                      <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label={t('common.delete')} />
                    </Popconfirm>
                  </Space>
                ),
              },
            ]}
          />
        </Card>
      </Space>
      )}

      <TradeModal open={modal.open} editing={modal.editing} onClose={() => setModal({ open: false, editing: null })} />
      <PriceModal
        symbol={pricing?.symbol ?? null}
        current={pricing?.price ?? null}
        onClose={() => setPricing(null)}
        onDone={() => {
          resolved(pricing?.symbol);
          setPricing(null);
        }}
      />
      <RenameModal
        symbol={renaming?.symbol ?? null}
        suggestion={renaming?.suggestion}
        onClose={() => setRenaming(null)}
        onDone={() => {
          resolved(renaming?.symbol);
          setRenaming(null);
        }}
      />
    </>
  );
}
