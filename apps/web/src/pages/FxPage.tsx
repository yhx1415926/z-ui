import { DeleteOutlined, EditOutlined, SwapOutlined, SyncOutlined } from '@ant-design/icons';
import { App, Alert, Button, Card, Form, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag, Tooltip } from 'antd';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { summaryCurrency, toMinor, type FxDto } from '@z-ui/shared';
import { del, post, put } from '../api/client.ts';
import { useAction, useConfig, useFx } from '../api/hooks.ts';
import { PageTop } from '../layouts/PanelLayout.tsx';
import { useDecimals, useLocale, useMoney } from '../lib/format.ts';

interface Row {
  currency: string;
  name: string;
  perUsd: number | null;
  asOf: string | null;
  source: string | null;
}

const PAIR_KEY = 'zui-fx-pair';

function readPair(): { from: string; to: string } | null {
  try {
    const v = JSON.parse(localStorage.getItem(PAIR_KEY) ?? 'null') as { from?: unknown; to?: unknown } | null;
    return v && typeof v.from === 'string' && typeof v.to === 'string' ? { from: v.from, to: v.to } : null;
  } catch {
    return null;
  }
}

/** Two-currency calculator over the stored rates (the last pair is remembered per browser). */
function Converter({ rows }: { rows: Row[] }) {
  const { t } = useTranslation();
  const money = useMoney();
  const decimals = useDecimals();
  const locale = useLocale();
  const { data: cfg } = useConfig();
  const [pair, setPairState] = useState(() => readPair() ?? { from: 'USD', to: cfg ? summaryCurrency(cfg) : 'CNY' });
  const [amount, setAmount] = useState<string | null>('100');
  const setPair = (next: { from: string; to: string }) => {
    setPairState(next);
    try {
      localStorage.setItem(PAIR_KEY, JSON.stringify(next));
    } catch {
      /* private mode: this visit only */
    }
  };

  const perUsd = (code: string) => (code === 'USD' ? 1 : (rows.find((r) => r.currency === code)?.perUsd ?? null));
  const a = perUsd(pair.from);
  const b = perUsd(pair.to);
  const rate = a && b ? b / a : null;
  const value = amount && rate !== null ? Number(amount) * rate : null;
  const options = rows.map((r) => ({ value: r.currency, label: `${r.currency} · ${r.name}` }));
  const nf = (n: number) => new Intl.NumberFormat(locale, { maximumSignificantDigits: 6 }).format(n);
  const asOf = [rows.find((r) => r.currency === pair.from)?.asOf, rows.find((r) => r.currency === pair.to)?.asOf].filter(Boolean).sort()[0];

  return (
    <Card title={t('fx.converter')} style={{ marginBottom: 16 }}>
      <div className="fx-converter">
        <div className="fx-side">
          <Select value={pair.from} options={options} onChange={(from) => setPair({ ...pair, from })} showSearch={{ optionFilterProp: 'label' }} aria-label={t('fx.from')} />
          <InputNumber<string>
            stringMode
            min="0"
            value={amount}
            onChange={setAmount}
            precision={decimals(pair.from)}
            size="large"
            style={{ width: '100%' }}
            aria-label={t('common.amount')}
          />
        </div>
        <Tooltip title={t('fx.swap')}>
          <Button shape="circle" icon={<SwapOutlined />} aria-label={t('fx.swap')} onClick={() => setPair({ from: pair.to, to: pair.from })} className="fx-swap" />
        </Tooltip>
        <div className="fx-side">
          <Select value={pair.to} options={options} onChange={(to) => setPair({ ...pair, to })} showSearch={{ optionFilterProp: 'label' }} aria-label={t('fx.to')} />
          <div className="fx-result num" aria-live="polite">
            {value === null ? <span className="muted">—</span> : money(toMinor(value.toFixed(decimals(pair.to)), decimals(pair.to)) ?? 0, pair.to)}
          </div>
        </div>
      </div>
      <div className="muted num" style={{ marginTop: 10, fontSize: 13 }}>
        {rate === null
          ? t('fx.noRateFor', { list: [pair.from, pair.to].filter((c) => perUsd(c) === null).join(', ') })
          : `1 ${pair.from} = ${nf(rate)} ${pair.to} · 1 ${pair.to} = ${nf(1 / rate)} ${pair.from}${asOf ? ` · ${t('fx.asOf', { date: asOf })}` : ''}`}
      </div>
    </Card>
  );
}

export function FxPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const locale = useLocale();
  const { data: cfg } = useConfig();
  const { data, isLoading } = useFx();
  const [editing, setEditing] = useState<Row | null>(null);
  const [form] = Form.useForm<{ perUsd: number }>();

  const sync = useAction(() => post<FxDto & { missing: string[] }>('/fx/sync'), { success: false });
  const save = useAction(async (v: { perUsd: number }) => {
    await put(`/fx/${editing!.currency}`, v);
    setEditing(null);
  });
  const remove = useAction((code: string) => del(`/fx/${code}`), { success: t('common.deleted') });

  const rates = new Map((data?.rates ?? []).map((r) => [r.currency, r]));
  // Every configured currency is listed (missing ones show "—"), plus stray stored ones.
  const codes = [...new Set([...(cfg?.currencies.map((c) => c.code) ?? []), ...rates.keys()])];
  const rows: Row[] = codes.map((code) => {
    const r = code === 'USD' ? { perUsd: 1, asOf: null, source: null } : rates.get(code);
    return {
      currency: code,
      name: cfg?.currencies.find((c) => c.code === code)?.name ?? code,
      perUsd: r?.perUsd ?? null,
      asOf: r?.asOf ?? null,
      source: r?.source ?? null,
    };
  });

  const nf = (n: number) => new Intl.NumberFormat(locale, { maximumSignificantDigits: 6 }).format(n);
  const synced = data?.syncedAt ? new Date(data.syncedAt).toLocaleString(locale) : t('fx.never');

  return (
    <>
      <PageTop
        title={t('fx.title')}
        extra={
          <Button
            type="primary"
            icon={<SyncOutlined spin={sync.isPending} />}
            loading={sync.isPending}
            onClick={() =>
              sync.mutate(undefined, {
                onSuccess: (r) => {
                  void message.success(t('fx.synced', { source: r.rates.find((x) => x.source !== 'manual')?.source ?? '' }));
                  if (r.missing.length) void message.warning(t('fx.missing', { list: r.missing.join(', ') }));
                },
              })
            }
          >
            {t('fx.sync')}
          </Button>
        }
      />
      <Alert type="info" showIcon message={t('fx.hint')} style={{ marginBottom: 16 }} />
      <Converter rows={rows} />
      <Card
        title={
          <span>
            {t('fx.lastSync')}: <span className="muted num">{synced}</span>
          </span>
        }
      >
        <Table<Row>
          rowKey="currency"
          size="middle"
          loading={isLoading}
          pagination={false}
          dataSource={rows}
          columns={[
            {
              title: t('common.currency'),
              dataIndex: 'currency',
              render: (code: string, r) => (
                <Space>
                  <b>{code}</b>
                  <span className="muted">{r.name}</span>
                </Space>
              ),
            },
            {
              title: t('fx.base'),
              dataIndex: 'perUsd',
              align: 'right',
              render: (v: number | null, r) => (v ? <span className="num">{`${nf(v)} ${r.currency}`}</span> : <span className="muted">—</span>),
            },
            {
              title: t('fx.inverse'),
              key: 'inverse',
              align: 'right',
              responsive: ['md'],
              render: (_, r) => (r.perUsd ? <span className="num muted">{`1 ${r.currency} = ${nf(1 / r.perUsd)} USD`}</span> : null),
            },
            {
              title: t('common.date'),
              dataIndex: 'asOf',
              render: (v: string | null, r) =>
                v ? (
                  <Space size={4}>
                    <span className="num">{v}</span>
                    {r.source === 'manual' ? <Tag color="gold">{t('fx.manual')}</Tag> : <Tag>{r.source}</Tag>}
                  </Space>
                ) : null,
            },
            {
              title: t('common.actions'),
              key: 'actions',
              width: 96,
              render: (_, r) =>
                r.currency === 'USD' ? null : (
                  <Space size={0}>
                    <Tooltip title={t('fx.edit')}>
                      <Button
                        type="text"
                        size="small"
                        icon={<EditOutlined />}
                        aria-label={t('fx.edit')}
                        onClick={() => {
                          setEditing(r);
                          form.setFieldsValue({ perUsd: r.perUsd ?? undefined });
                        }}
                      />
                    </Tooltip>
                    {r.perUsd !== null && (
                      <Popconfirm title={t('common.deleteConfirm')} onConfirm={() => remove.mutate(r.currency)}>
                        <Button type="text" size="small" danger icon={<DeleteOutlined />} aria-label={t('common.delete')} />
                      </Popconfirm>
                    )}
                  </Space>
                ),
            },
          ]}
        />
      </Card>

      <Modal
        open={!!editing}
        title={`${t('fx.edit')} · ${editing?.currency ?? ''}`}
        onCancel={() => setEditing(null)}
        onOk={() => form.submit()}
        confirmLoading={save.isPending}
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
          <Form.Item name="perUsd" label={`${t('fx.base')} ? ${editing?.currency ?? ''}`} rules={[{ required: true }]}>
            <InputNumber min={0.000001} step={0.01} stringMode={false} style={{ width: '100%' }} autoFocus />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
