import { CheckOutlined, DeleteOutlined, EditOutlined, PlusOutlined, RollbackOutlined, StepForwardOutlined } from '@ant-design/icons';
import { App, Button, Card, Col, Collapse, DatePicker, Empty, Form, Input, InputNumber, Modal, Radio, Row, Segmented, Select, Skeleton, Space, Switch, Table, Tabs, Tag, Tooltip, type TableColumnsType } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { fromMinor, PAST_POLICIES, RECURRENCE_FREQS, todayIso, type BillDto, type BillOccurrenceDto, type PastPolicy } from '@z-ui/shared';
import { del, patch, post } from '../api/client.ts';
import { useAction, useBills, useConfig, useOccurrences } from '../api/hooks.ts';
import { MoneyInput, MoneyText } from '../components/Money.tsx';
import { PageTop } from '../layouts/PanelLayout.tsx';
import { cardLabel, useAccountOptions, useDecimals, useFxConvert, useLookups, useMoney } from '../lib/format.ts';

interface BillForm extends Omit<Partial<BillDto>, 'startDate' | 'endDate'> {
  startDate?: Dayjs;
  endDate?: Dayjs | null;
  pastPolicy?: PastPolicy;
}

function useCardOptions() {
  const L = useLookups();
  return useMemo(() => L.cards.filter((c) => !c.archived && c.status !== 'closed').map((c) => ({ value: c.id, label: cardLabel(c) })), [L.cards]);
}

function BillModal({ open, editing, onClose }: { open: boolean; editing: BillDto | null; onClose: () => void }) {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const { data: cfg } = useConfig();
  const L = useLookups();
  const [form] = Form.useForm<BillForm>();
  const currency = Form.useWatch('currency', form) ?? cfg?.app.defaultCurrency ?? 'USD';
  const kind = Form.useWatch('kind', form) ?? 'subscription';
  const startDate = Form.useWatch('startDate', form);
  const accountOptions = useAccountOptions();
  const cardOptions = useCardOptions();
  const startsInPast = !editing && !!startDate && startDate.format('YYYY-MM-DD') < todayIso();
  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(
      editing
        ? { ...editing, startDate: dayjs(editing.startDate), endDate: editing.endDate ? dayjs(editing.endDate) : null }
        : {
            kind: 'subscription',
            freq: 'monthly',
            interval: 1,
            currency: cfg?.app.defaultCurrency,
            startDate: dayjs(),
            remindDaysBefore: cfg?.reminders.defaultDaysBefore ?? 3,
            active: true,
            pastPolicy: 'record',
          },
    );
  }, [open, editing, form, cfg]);
  const save = useAction(async (v: BillForm) => {
    const body = {
      ...v,
      freq: v.kind === 'once' ? null : v.freq,
      startDate: v.startDate!.format('YYYY-MM-DD'),
      endDate: v.kind === 'once' || !v.endDate ? null : v.endDate.format('YYYY-MM-DD'),
      accountId: v.accountId ?? null,
      cardId: v.cardId ?? null,
      categoryId: v.categoryId ?? null,
      ...(editing ? { pastPolicy: undefined } : {}),
    };
    if (editing) await patch(`/bills/${editing.id}`, body);
    else {
      const r = await post<BillDto>('/bills', body);
      if (r.past?.recorded) void message.info(t('bill.pastRecorded', { n: r.past.recorded }));
      if (r.past?.markedPaid) void message.info(t('bill.pastMarked', { n: r.past.markedPaid }));
    }
    onClose();
  });
  return (
    <Modal open={open} title={editing ? t('bill.edit') : t('bill.add')} onCancel={onClose} onOk={() => form.submit()} confirmLoading={save.isPending} destroyOnHidden width={540}>
      <Form form={form} layout="vertical" requiredMark={false} onFinish={(v) => save.mutate(v)} style={{ marginTop: 12 }}>
        <Form.Item name="kind">
          <Segmented block options={(['subscription', 'once'] as const).map((k) => ({ value: k, label: t(`bill.kinds.${k}`) }))} />
        </Form.Item>
        <Form.Item name="name" label={t('common.name')} rules={[{ required: true, max: 64 }]}>
          <Input autoFocus placeholder="ChatGPT Plus / Netflix / 签证费" />
        </Form.Item>
        <Row gutter={12}>
          <Col span={8}>
            <Form.Item name="currency" label={t('common.currency')} rules={[{ required: true }]}>
              <Select showSearch={{ optionFilterProp: 'label' }} options={cfg?.currencies.map((c) => ({ value: c.code, label: c.code }))} />
            </Form.Item>
          </Col>
          <Col span={16}>
            <Form.Item name="amount" label={t('common.amount')} rules={[{ required: true }]}>
              <MoneyInput currency={currency} />
            </Form.Item>
          </Col>
        </Row>
        {kind === 'subscription' ? (
          <>
            <Row gutter={12}>
              <Col span={8}>
                <Form.Item name="freq" label={t('bill.freq')} rules={[{ required: true }]}>
                  <Select options={RECURRENCE_FREQS.map((f) => ({ value: f, label: t(`bill.freqs.${f}`) }))} />
                </Form.Item>
              </Col>
              <Col span={6}>
                <Form.Item name="interval" label={t('bill.interval')}>
                  <InputNumber min={1} max={24} style={{ width: '100%' }} />
                </Form.Item>
              </Col>
              <Col span={10}>
                <Form.Item name="remindDaysBefore" label={t('bill.remind')}>
                  <InputNumber min={0} max={60} style={{ width: '100%' }} suffix={t('bill.remindDays', { n: '' }).trim()} />
                </Form.Item>
              </Col>
            </Row>
            <Row gutter={12}>
              <Col span={12}>
                <Form.Item name="startDate" label={t('bill.startDate')} rules={[{ required: true }]}>
                  <DatePicker style={{ width: '100%' }} allowClear={false} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="endDate" label={t('bill.endDate')}>
                  <DatePicker style={{ width: '100%' }} placeholder={t('common.optional')} />
                </Form.Item>
              </Col>
            </Row>
          </>
        ) : (
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="startDate" label={t('bill.dueDate')} rules={[{ required: true }]}>
                <DatePicker style={{ width: '100%' }} allowClear={false} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="remindDaysBefore" label={t('bill.remind')}>
                <InputNumber min={0} max={60} style={{ width: '100%' }} suffix={t('bill.remindDays', { n: '' }).trim()} />
              </Form.Item>
            </Col>
          </Row>
        )}
        {startsInPast && (
          <Form.Item name="pastPolicy" label={t('bill.pastHint')}>
            <Radio.Group options={PAST_POLICIES.map((p) => ({ value: p, label: t(`bill.pastPolicies.${p}`) }))} />
          </Form.Item>
        )}
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="cardId" label={t('tx.card')}>
              <Select
                allowClear
                options={cardOptions}
                placeholder={t('common.optional')}
                onChange={(id) => {
                  const c = id ? L.card.get(id) : undefined;
                  if (c) form.setFieldValue('accountId', c.accountId);
                }}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="accountId" label={t('bill.payFrom')}>
              <Select allowClear options={accountOptions} placeholder={t('common.optional')} />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={12}>
          <Col span={16}>
            <Form.Item name="categoryId" label={t('tx.category')}>
              <Select
                allowClear
                showSearch={{ optionFilterProp: 'label' }}
                options={L.categories.filter((c) => c.kind === 'expense' && !c.archived).map((c) => ({ value: c.id, label: c.name }))}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="active" label={t('bill.active')} valuePropName="checked">
              <Switch />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="note" label={t('common.note')}>
          <Input.TextArea autoSize={{ minRows: 1, maxRows: 3 }} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function PayModal({ occ, bill, onClose }: { occ: BillOccurrenceDto | null; bill: BillDto | undefined; onClose: () => void }) {
  const { t } = useTranslation();
  const L = useLookups();
  const [form] = Form.useForm();
  const accountOptions = useAccountOptions();
  const cardOptions = useCardOptions();
  const accountId = Form.useWatch('accountId', form);
  const curField = Form.useWatch('currency', form);
  const account = accountId ? L.acc.get(accountId) : undefined;
  const held = account?.currencies.map((c) => c.currency) ?? [];
  const currency = curField ?? (occ && held.includes(occ.currency) ? occ.currency : account?.currency);
  // Paid in another currency (a USD bill from a CNY wallet): the charged amount may be left blank.
  const cross = !!occ && !!currency && currency !== occ.currency;
  const fx = useFxConvert();
  const money = useMoney();
  const decimals = useDecimals();
  const amount = Form.useWatch('amount', form);
  const estimate = cross ? fx(occ.amount, occ.currency, currency) : null;
  useEffect(() => {
    if (occ) form.setFieldValue('amount', cross ? null : occ.amount);
  }, [cross, occ, form]);
  useEffect(() => {
    if (!occ) return;
    form.resetFields();
    const today = todayIso();
    form.setFieldsValue({
      cardId: bill?.cardId ?? null,
      accountId: bill?.cardId ? L.card.get(bill.cardId)?.accountId : (bill?.accountId ?? undefined),
      amount: occ.amount,
      occurredAt: dayjs(occ.dueDate < today ? occ.dueDate : today),
    });
  }, [occ, bill, form, L.card]);
  const pay = useAction(async (v: { accountId: string; cardId?: string | null; amount?: number | null; occurredAt: Dayjs; note?: string }) => {
    await post(`/bills/occurrences/${occ!.id}/pay`, { ...v, amount: v.amount ?? null, currency, cardId: v.cardId ?? null, occurredAt: v.occurredAt.format('YYYY-MM-DD') });
    onClose();
  });
  return (
    <Modal open={!!occ} title={`${t('bill.payTitle')} · ${occ?.billName ?? ''}`} onCancel={onClose} onOk={() => form.submit()} confirmLoading={pay.isPending} destroyOnHidden>
      <p className="muted">{t('bill.payHint')}</p>
      <Form form={form} layout="vertical" requiredMark={false} onFinish={(v) => pay.mutate(v)}>
        <Form.Item name="cardId" label={t('tx.card')}>
          <Select
            allowClear
            options={cardOptions}
            onChange={(id) => {
              const c = id ? L.card.get(id) : undefined;
              if (c) form.setFieldValue('accountId', c.accountId);
            }}
          />
        </Form.Item>
        <Form.Item name="accountId" label={t('tx.account')} rules={[{ required: true }]}>
          <Select options={accountOptions} onChange={() => (form.setFieldValue('cardId', null), form.setFieldValue('currency', undefined))} />
        </Form.Item>
        <Form.Item
          label={cross ? t('tx.paidAmount', { currency }) : t('common.amount')}
          required={!cross}
          htmlFor="amount"
          extra={
            cross && occ
              ? `${t('bill.billed', { amount: money(occ.amount, occ.currency) })} · ${
                  amount ? '' : estimate !== null ? t('tx.autoRate', { amount: money(estimate, currency!) }) : t('tx.noRate', { from: occ.currency, to: currency })
                }`
              : undefined
          }
        >
          <Space.Compact block>
            {held.length > 1 && (
              <Form.Item name="currency" noStyle>
                <Select style={{ width: 96 }} value={currency} options={held.map((c) => ({ value: c, label: c }))} />
              </Form.Item>
            )}
            <Form.Item name="amount" noStyle rules={[{ required: !cross }]}>
              <MoneyInput currency={currency ?? occ?.currency ?? '—'} placeholder={estimate !== null ? fromMinor(estimate, decimals(currency!)) : undefined} />
            </Form.Item>
          </Space.Compact>
        </Form.Item>
        <Form.Item name="occurredAt" label={t('common.date')} rules={[{ required: true }]}>
          <DatePicker style={{ width: '100%' }} allowClear={false} />
        </Form.Item>
        <Form.Item name="note" label={t('common.note')}>
          <Input />
        </Form.Item>
      </Form>
    </Modal>
  );
}

const STATUS_COLOR = { pending: 'processing', paid: 'success', skipped: 'default' } as const;

function OccurrenceRow({ o, onPay }: { o: BillOccurrenceDto; onPay: (o: BillOccurrenceDto) => void }) {
  const { t } = useTranslation();
  const { modal } = App.useApp();
  const skip = useAction((id: string) => post(`/bills/occurrences/${id}/skip`));
  const reset = useAction((id: string) => post(`/bills/occurrences/${id}/reset`));
  const overdue = o.status === 'pending' && o.dueDate < todayIso();
  return (
    <motion.div layout initial={{ opacity: 0 }} animate={{ opacity: o.status === 'pending' ? 1 : 0.7 }} exit={{ opacity: 0 }}>
      <div className="row-item">
        <div style={{ width: 58, flex: 'none', textAlign: 'center' }}>
          <div style={{ fontSize: 16, fontWeight: 600, lineHeight: 1.2, whiteSpace: 'nowrap' }} className={overdue ? 'num expense' : 'num'}>
            {o.dueDate.slice(5)}
          </div>
          <div className="muted" style={{ fontSize: 11 }}>
            {o.dueDate.slice(0, 4)}
          </div>
        </div>
        <div className="row-main">
          <div className="row-title">{o.billName}</div>
          <div className="row-sub">{t(`bill.kinds.${o.billKind}`)}</div>
        </div>
        <MoneyText minor={o.amount} currency={o.currency} style={{ fontWeight: 600 }} />
        <Tag color={overdue ? 'error' : STATUS_COLOR[o.status]} style={{ minWidth: 56, textAlign: 'center', marginInlineEnd: 0 }}>
          {o.status === 'paid' && !o.transactionId ? t('bill.paidNoTx') : t(`bill.statuses.${o.status}`)}
        </Tag>
        <Space size={4}>
          {o.status === 'pending' ? (
            <>
              <Tooltip title={t('bill.pay')}>
                <Button type="primary" size="small" icon={<CheckOutlined />} onClick={() => onPay(o)} />
              </Tooltip>
              <Tooltip title={t('bill.skip')}>
                <Button size="small" icon={<StepForwardOutlined />} onClick={() => skip.mutate(o.id)} />
              </Tooltip>
            </>
          ) : (
            <Tooltip title={t('bill.reset')}>
              <Button
                size="small"
                icon={<RollbackOutlined />}
                onClick={() => (o.transactionId ? modal.confirm({ title: t('bill.resetConfirm'), onOk: () => reset.mutateAsync(o.id) }) : reset.mutate(o.id))}
              />
            </Tooltip>
          )}
        </Space>
      </div>
    </motion.div>
  );
}

/**
 * Schedule: overdue first, then upcoming grouped by month; paid/skipped history is folded away
 * (newest first, paged) so it never pushes the current bills down.
 */
function Schedule({ bills }: { bills: BillDto[] }) {
  const { t } = useTranslation();
  const { data = [], isLoading } = useOccurrences();
  const [paying, setPaying] = useState<BillOccurrenceDto | null>(null);
  const [historyShown, setHistoryShown] = useState(24);
  const today = todayIso();
  const { overdue, upcoming, history } = useMemo(() => {
    const pending = data.filter((o) => o.status === 'pending');
    const months = new Map<string, BillOccurrenceDto[]>();
    for (const o of pending.filter((x) => x.dueDate >= today)) months.set(o.dueDate.slice(0, 7), [...(months.get(o.dueDate.slice(0, 7)) ?? []), o]);
    return {
      overdue: pending.filter((o) => o.dueDate < today),
      upcoming: [...months],
      history: data.filter((o) => o.status !== 'pending').reverse(),
    };
  }, [data, today]);

  if (isLoading) return <Skeleton active />;
  return (
    <>
      {overdue.length > 0 && (
        <Card title={<span className="expense">{t('bill.overdue')} · {overdue.length}</span>} size="small" style={{ marginBottom: 16 }} styles={{ body: { paddingTop: 4, paddingBottom: 4 } }}>
          <AnimatePresence initial={false}>
            {overdue.map((o) => (
              <OccurrenceRow key={o.id} o={o} onPay={setPaying} />
            ))}
          </AnimatePresence>
        </Card>
      )}
      {upcoming.length === 0 && overdue.length === 0 && (
        <Card size="small" style={{ marginBottom: 16 }}>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('bill.noPending')} />
        </Card>
      )}
      {upcoming.map(([month, list]) => (
        <Card key={month} title={`${t('bill.upcomingTitle')} · ${month}`} size="small" style={{ marginBottom: 16 }} styles={{ body: { paddingTop: 4, paddingBottom: 4 } }}>
          <AnimatePresence initial={false}>
            {list.map((o) => (
              <OccurrenceRow key={o.id} o={o} onPay={setPaying} />
            ))}
          </AnimatePresence>
        </Card>
      ))}
      {history.length > 0 && (
        <Collapse
          items={[
            {
              key: 'history',
              label: `${t('bill.history')} · ${history.length}`,
              children: (
                <>
                  {history.slice(0, historyShown).map((o) => (
                    <OccurrenceRow key={o.id} o={o} onPay={setPaying} />
                  ))}
                  {history.length > historyShown && (
                    <Button block type="dashed" style={{ marginTop: 8 }} onClick={() => setHistoryShown((n) => n + 48)}>
                      {t('bill.loadMore')}
                    </Button>
                  )}
                </>
              ),
            },
          ]}
        />
      )}
      <PayModal occ={paying} bill={bills.find((b) => b.id === paying?.billId)} onClose={() => setPaying(null)} />
    </>
  );
}

export function BillsPage() {
  const { t } = useTranslation();
  const { modal } = App.useApp();
  const { data: bills = [], isLoading } = useBills();
  const L = useLookups();
  const [edit, setEdit] = useState<{ open: boolean; editing: BillDto | null }>({ open: false, editing: null });
  const toggle = useAction((b: BillDto) => patch(`/bills/${b.id}`, { active: !b.active }));
  const remove = useAction((b: BillDto) => del(`/bills/${b.id}`), { success: t('common.deleted') });

  const columns: TableColumnsType<BillDto> = [
    { key: 'name', title: t('common.name'), render: (_, b) => <span style={{ fontWeight: 500 }}>{b.name}</span> },
    { key: 'kind', title: t('common.type'), render: (_, b) => <Tag color={b.kind === 'once' ? 'orange' : 'blue'}>{t(`bill.kinds.${b.kind}`)}</Tag> },
    { key: 'amount', title: t('common.amount'), align: 'right', render: (_, b) => <MoneyText minor={b.amount} currency={b.currency} /> },
    {
      key: 'freq',
      title: t('bill.freq'),
      render: (_, b) =>
        !b.freq ? '—' : b.interval === 1 ? t(`bill.freqs.${b.freq}`) : t('bill.every', { n: b.interval, unit: t(`bill.units.${b.freq}`) }),
    },
    { key: 'next', title: t('bill.next'), render: (_, b) => b.nextDueDate ?? '—' },
    {
      key: 'from',
      title: t('bill.payFrom'),
      responsive: ['lg'],
      render: (_, b) => <span className="muted">{b.cardId && L.card.get(b.cardId) ? cardLabel(L.card.get(b.cardId)!) : L.accountLabel(b.accountId) || '—'}</span>,
    },
    { key: 'active', title: t('bill.active'), render: (_, b) => <Switch size="small" checked={b.active} onChange={() => toggle.mutate(b)} /> },
    {
      key: 'actions',
      title: '',
      width: 96,
      render: (_, b) => (
        <Space size={4}>
          <Button size="small" type="text" icon={<EditOutlined />} onClick={() => setEdit({ open: true, editing: b })} />
          <Button
            size="small"
            type="text"
            danger
            icon={<DeleteOutlined />}
            onClick={() => modal.confirm({ title: t('common.deleteConfirm'), okButtonProps: { danger: true }, onOk: () => remove.mutateAsync(b) })}
          />
        </Space>
      ),
    },
  ];

  return (
    <>
      <PageTop
        title={t('nav.bills')}
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setEdit({ open: true, editing: null })}>
            {t('bill.add')}
          </Button>
        }
      />
      {isLoading ? (
        <Skeleton active />
      ) : bills.length === 0 ? (
        <Card>
          <Empty>
            <Button type="primary" onClick={() => setEdit({ open: true, editing: null })}>
              {t('bill.add')}
            </Button>
          </Empty>
        </Card>
      ) : (
        <Tabs
          items={[
            { key: 'schedule', label: t('bill.schedule'), children: <Schedule bills={bills} /> },
            {
              key: 'list',
              label: t('bill.list'),
              children: (
                <Card styles={{ body: { padding: 0 } }}>
                  <Table<BillDto> rowKey="id" columns={columns} dataSource={bills} pagination={false} scroll={{ x: 560 }} />
                </Card>
              ),
            },
          ]}
        />
      )}
      <BillModal open={edit.open} editing={edit.editing} onClose={() => setEdit({ open: false, editing: null })} />
    </>
  );
}
