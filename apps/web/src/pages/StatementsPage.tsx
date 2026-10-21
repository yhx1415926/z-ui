import { DeleteOutlined, EditOutlined, PayCircleOutlined, PlusOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { App, Button, Card, Col, DatePicker, Empty, Form, Input, Modal, Progress, Row, Segmented, Select, Space, Table, Tag, type TableColumnsType } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { addMonths, nextDayOfMonth, todayIso, type CardDto, type StatementDto } from '@z-ui/shared';
import { del, patch, post } from '../api/client.ts';
import { useAction, useStatements } from '../api/hooks.ts';
import { MoneyInput, MoneyText } from '../components/Money.tsx';
import { PageTop } from '../layouts/PanelLayout.tsx';
import { useAccountOptions, useFxConvert, useLookups } from '../lib/format.ts';

const cardLabel = (c: CardDto) => `${c.nickname ?? c.brand.toUpperCase()} •••• ${c.last4}`;

interface StatementForm {
  cardId: string;
  currency?: string;
  statementDate: Dayjs;
  dueDate: Dayjs;
  period?: [Dayjs, Dayjs] | null;
  statementAmount: number;
  minPayment?: number | null;
  note?: string;
}

function StatementModal({ open, editing, onClose }: { open: boolean; editing: StatementDto | null; onClose: () => void }) {
  const { t } = useTranslation();
  const L = useLookups();
  const [form] = Form.useForm<StatementForm>();
  const creditCards = L.cards.filter((c) => c.funding === 'credit' && !c.archived);
  const cardId = Form.useWatch('cardId', form);
  const card = cardId ? L.card.get(cardId) : undefined;
  const cardAccount = card ? L.acc.get(card.accountId) : undefined;
  // Dual-currency cards: one statement per currency.
  const currency = Form.useWatch('currency', form) ?? cardAccount?.currency ?? '—';

  // Default dates: the most recent statement day and the following due day.
  const defaultsFor = (c: CardDto | undefined) => {
    const today = todayIso();
    const stDate = c?.statementDay ? nextDayOfMonth(addMonths(today, -1), c.statementDay) : today;
    const due = c?.dueDay ? nextDayOfMonth(stDate, c.dueDay) : stDate;
    return { statementDate: dayjs(stDate), dueDate: dayjs(due) };
  };

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    if (editing) {
      form.setFieldsValue({
        ...editing,
        statementDate: dayjs(editing.statementDate),
        dueDate: dayjs(editing.dueDate),
        period: editing.periodStart && editing.periodEnd ? [dayjs(editing.periodStart), dayjs(editing.periodEnd)] : null,
        note: editing.note ?? undefined,
      });
    } else {
      const first = creditCards[0];
      form.setFieldsValue({ cardId: first?.id, ...defaultsFor(first) });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing]);

  const save = useAction(async (v: StatementForm) => {
    const body = {
      cardId: v.cardId,
      currency: v.currency ?? cardAccount?.currency,
      statementDate: v.statementDate.format('YYYY-MM-DD'),
      dueDate: v.dueDate.format('YYYY-MM-DD'),
      periodStart: v.period?.[0]?.format('YYYY-MM-DD') ?? null,
      periodEnd: v.period?.[1]?.format('YYYY-MM-DD') ?? null,
      statementAmount: v.statementAmount,
      minPayment: v.minPayment ?? null,
      note: v.note || null,
    };
    if (editing) await patch(`/statements/${editing.id}`, body);
    else await post('/statements', body);
    onClose();
  });

  return (
    <Modal open={open} title={editing ? t('statement.edit') : t('statement.add')} onCancel={onClose} onOk={() => form.submit()} confirmLoading={save.isPending} destroyOnHidden>
      <Form form={form} layout="vertical" requiredMark={false} onFinish={(v) => save.mutate(v)} style={{ marginTop: 12 }}>
        <Form.Item name="cardId" label={t('statement.card')} rules={[{ required: true }]}>
          <Select
            options={creditCards.map((c) => ({ value: c.id, label: cardLabel(c) }))}
            onChange={(id) => {
              form.setFieldValue('currency', undefined);
              if (!editing) form.setFieldsValue(defaultsFor(L.card.get(id)));
            }}
          />
        </Form.Item>
        {cardAccount && cardAccount.currencies.length > 1 && (
          <Form.Item name="currency" label={t('common.currency')}>
            <Segmented options={cardAccount.currencies.map((c) => c.currency)} />
          </Form.Item>
        )}
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="statementDate" label={t('statement.statementDate')} rules={[{ required: true }]}>
              <DatePicker style={{ width: '100%' }} allowClear={false} />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="dueDate" label={t('statement.dueDate')} rules={[{ required: true }]}>
              <DatePicker style={{ width: '100%' }} allowClear={false} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="period" label={t('statement.period')}>
          <DatePicker.RangePicker style={{ width: '100%' }} />
        </Form.Item>
        <Row gutter={12}>
          <Col span={12}>
            <Form.Item name="statementAmount" label={t('statement.amount')} rules={[{ required: true }]}>
              <MoneyInput currency={currency} autoFocus />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item name="minPayment" label={t('statement.minPayment')}>
              <MoneyInput currency={currency} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="note" label={t('common.note')}>
          <Input />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function RepayModal({ statement, onClose }: { statement: StatementDto | null; onClose: () => void }) {
  const { t } = useTranslation();
  const L = useLookups();
  const [form] = Form.useForm();
  const fromId = Form.useWatch('fromAccountId', form);
  const from = fromId ? L.acc.get(fromId) : undefined;
  const held = from?.currencies.map((c) => c.currency) ?? [];
  // Pay in the statement's currency when the funding account holds it.
  const fromCurrency = Form.useWatch('fromCurrency', form) ?? (statement && held.includes(statement.currency) ? statement.currency : from?.currency);
  const cross = !!fromCurrency && !!statement && fromCurrency !== statement.currency;
  const accountOptions = useAccountOptions();
  const fx = useFxConvert();
  useEffect(() => {
    if (!statement) return;
    form.resetFields();
    form.setFieldsValue({ amount: statement.remaining, toAmount: statement.remaining, occurredAt: dayjs() });
  }, [statement, form]);
  // Paying from another currency: what the remainder costs at the current rate (editable).
  useEffect(() => {
    if (!statement || !fromCurrency) return;
    form.setFieldsValue(cross ? { amount: fx(statement.remaining, statement.currency, fromCurrency) ?? undefined, toAmount: statement.remaining } : { amount: statement.remaining });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cross, fromCurrency, statement]);
  const repay = useAction(async (v: { fromAccountId: string; amount: number; toAmount?: number; occurredAt: Dayjs; note?: string }) => {
    await post(`/statements/${statement!.id}/repay`, { ...v, fromCurrency, toAmount: cross ? v.toAmount : null, occurredAt: v.occurredAt.format('YYYY-MM-DD') });
    onClose();
  });
  return (
    <Modal open={!!statement} title={t('statement.repayTitle')} onCancel={onClose} onOk={() => form.submit()} confirmLoading={repay.isPending} destroyOnHidden>
      <Form form={form} layout="vertical" requiredMark={false} onFinish={(v) => repay.mutate(v)} style={{ marginTop: 12 }}>
        <Form.Item name="fromAccountId" label={t('statement.repayFrom')} rules={[{ required: true }]}>
          <Select
            options={accountOptions.map((g) => ({ ...g, options: g.options.filter((o) => o.value !== statement?.accountId) }))}
            onChange={() => form.setFieldValue('fromCurrency', undefined)}
          />
        </Form.Item>
        <Form.Item label={t('common.amount')} required htmlFor="amount">
          <Space.Compact block>
            {held.length > 1 && (
              <Form.Item name="fromCurrency" noStyle>
                <Select style={{ width: 96 }} value={fromCurrency} options={held.map((c) => ({ value: c, label: c }))} />
              </Form.Item>
            )}
            <Form.Item name="amount" noStyle rules={[{ required: true }]}>
              <MoneyInput currency={fromCurrency ?? statement?.currency ?? '—'} />
            </Form.Item>
          </Space.Compact>
        </Form.Item>
        {cross && (
          <Form.Item name="toAmount" label={t('tx.toAmount')} extra={t('tx.toAmountHint')}>
            <MoneyInput currency={statement!.currency} />
          </Form.Item>
        )}
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

const STATUS_COLOR = { unpaid: 'error', partial: 'warning', paid: 'success' } as const;

export function StatementsPage() {
  const { t } = useTranslation();
  const { modal } = App.useApp();
  const L = useLookups();
  const { data: statements = [], isLoading } = useStatements();
  const [edit, setEdit] = useState<{ open: boolean; editing: StatementDto | null }>({ open: false, editing: null });
  const [repaying, setRepaying] = useState<StatementDto | null>(null);
  const remove = useAction((s: StatementDto) => del(`/statements/${s.id}`), { success: t('common.deleted') });
  const creditCards = L.cards.filter((c) => c.funding === 'credit' && !c.archived);

  const columns: TableColumnsType<StatementDto> = [
    { key: 'card', title: t('statement.card'), render: (_, s) => <span style={{ fontWeight: 500 }}>{L.card.get(s.cardId) ? cardLabel(L.card.get(s.cardId)!) : '—'}</span> },
    { key: 'sd', title: t('statement.statementDate'), dataIndex: 'statementDate', responsive: ['md'] },
    { key: 'dd', title: t('statement.dueDate'), dataIndex: 'dueDate' },
    { key: 'amt', title: t('statement.amount'), align: 'right', render: (_, s) => <MoneyText minor={s.statementAmount} currency={s.currency} /> },
    {
      key: 'progress',
      title: t('statement.paid'),
      width: 180,
      render: (_, s) => (
        <div>
          <Progress percent={s.statementAmount ? Math.round((s.paidAmount / s.statementAmount) * 100) : 100} size="small" status={s.status === 'paid' ? 'success' : 'active'} />
          {s.remaining > 0 && (
            <span className="muted" style={{ fontSize: 12 }}>
              {t('statement.remaining')} <MoneyText minor={s.remaining} currency={s.currency} />
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'status',
      title: t('common.status'),
      render: (_, s) => (
        <Space size={4} wrap>
          <Tag color={STATUS_COLOR[s.status]}>{t(`statement.statuses.${s.status}`)}</Tag>
          {s.autopayAt && (
            <Tag icon={<ThunderboltOutlined />} color="blue">
              {t('autopay.done')}
            </Tag>
          )}
        </Space>
      ),
    },
    {
      key: 'actions',
      title: '',
      width: 150,
      render: (_, s) => (
        <Space size={4}>
          {s.remaining > 0 && (
            <Button size="small" type="primary" icon={<PayCircleOutlined />} onClick={() => setRepaying(s)}>
              {t('statement.repay')}
            </Button>
          )}
          <Button size="small" type="text" icon={<EditOutlined />} onClick={() => setEdit({ open: true, editing: s })} />
          <Button
            size="small"
            type="text"
            danger
            icon={<DeleteOutlined />}
            onClick={() => modal.confirm({ title: t('common.deleteConfirm'), okButtonProps: { danger: true }, onOk: () => remove.mutateAsync(s) })}
          />
        </Space>
      ),
    },
  ];

  return (
    <>
      <PageTop
        title={t('nav.statements')}
        extra={
          <Button type="primary" icon={<PlusOutlined />} disabled={creditCards.length === 0} onClick={() => setEdit({ open: true, editing: null })}>
            {t('statement.add')}
          </Button>
        }
      />
      {creditCards.length === 0 ? (
        <Card>
          <Empty description={t('statement.noCreditCards')} />
        </Card>
      ) : (
        <>
          <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
            {creditCards.map((c, i) => {
              const acc = L.acc.get(c.accountId);
              const primary = acc?.currencies.find((x) => x.currency === acc.currency);
              const debt = primary ? Math.max(0, -primary.balance) : 0;
              const latest = statements.find((s) => s.cardId === c.id);
              const used = acc?.creditLimit ? Math.min(100, Math.round((debt / acc.creditLimit) * 100)) : null;
              return (
                <Col key={c.id} xs={24} md={12} xl={8}>
                  <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0, transition: { delay: i * 0.05 } }}>
                    <Card hoverable size="small" className="stat-tile">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontWeight: 600 }}>{cardLabel(c)}</span>
                        <span className={`dot card-theme-${c.theme}`} />
                      </div>
                      <div className="stat-net">{acc && <MoneyText minor={-debt} currency={acc.currency} colored={debt > 0} animated />}</div>
                      {used !== null && <Progress percent={used} size="small" showInfo={false} strokeColor={used > 80 ? 'var(--expense)' : undefined} />}
                      <div className="stat-split">
                        <span>
                          {t('card.statementDay')} {c.statementDay ?? '—'} · {t('card.dueDay')} {c.dueDay ?? '—'}
                        </span>
                        {latest && <Tag color={STATUS_COLOR[latest.status]}>{latest.dueDate}</Tag>}
                      </div>
                      {c.autopayAccountId && (
                        <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                          <ThunderboltOutlined /> {t('autopay.from', { account: L.accountLabel(c.autopayAccountId) })} · {t(`autopay.modes.${c.autopayMode ?? 'full'}`)}
                        </div>
                      )}
                    </Card>
                  </motion.div>
                </Col>
              );
            })}
          </Row>
          <Card styles={{ body: { padding: 0 } }}>
            <Table<StatementDto> rowKey="id" loading={isLoading} columns={columns} dataSource={statements} pagination={{ pageSize: 20, hideOnSinglePage: true }} scroll={{ x: 720 }} />
          </Card>
        </>
      )}
      <StatementModal open={edit.open} editing={edit.editing} onClose={() => setEdit({ open: false, editing: null })} />
      <RepayModal statement={repaying} onClose={() => setRepaying(null)} />
    </>
  );
}
