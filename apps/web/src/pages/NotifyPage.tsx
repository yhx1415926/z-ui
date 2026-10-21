import { MailOutlined, PlayCircleOutlined, SaveOutlined, UndoOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, App, Button, Card, Col, Collapse, Form, Input, InputNumber, Row, Space, Switch, Table, Tag, Typography } from 'antd';
import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import {
  COMMON_VARS,
  DEFAULT_RULES,
  NOTIFY_HAS_DAYS,
  NOTIFY_KINDS,
  NOTIFY_VARS,
  renderTemplate,
  todayIso,
  type NotificationLogDto,
  type NotifyDto,
  type NotifyKind,
  type NotifyRunDto,
  type NotifySettings,
} from '@z-ui/shared';
import { post, put } from '../api/client.ts';
import { useAction, useConfig, useNotify } from '../api/hooks.ts';
import { PageTop } from '../layouts/PanelLayout.tsx';
import { useLocale } from '../lib/format.ts';

/** Example values for the template preview. */
const SAMPLE: Record<NotifyKind, Record<string, string | number>> = {
  autopay_low: { card: '招行 Visa', account: '支付宝 · 余额', balance: '¥320.00', needed: '¥1,440.00', dueDate: '2026-11-05', daysLeft: 3 },
  autopay_done: { card: '招行 Visa', account: '招商银行 · 一卡通', amount: '¥3,250.00', paid: '¥3,250.00', dueDate: '2026-11-05' },
  price_alert: { symbol: 'AAPL', name: 'Apple Inc.', price: '$231.40', target: '$230.00', direction: '涨到', time: '2026-10-21 14:30 UTC' },
  bill_due: { bill: 'ChatGPT Plus', amount: '$20.00', dueDate: '2026-11-01', daysLeft: 1 },
  bill_overdue: { bill: 'iCloud+', amount: '¥21.00', dueDate: '2026-10-19', daysOverdue: 2 },
  statement_due: { card: '招行 Visa', amount: '¥3,250.00', dueDate: '2026-11-05', daysLeft: 3, dueText: '还剩 3 天' },
  over_limit: { account: '招商银行 · 信用卡', owed: '¥52,300.00', limit: '¥50,000.00', over: '¥2,300.00' },
  card_expiry: { card: '中行 Mastercard', expiry: '12/2026', daysLeft: 30 },
};

function TemplateEditor({ kind, appName }: { kind: NotifyKind; appName: string }) {
  const { t } = useTranslation();
  const form = Form.useFormInstance();
  const name = ['rules', kind];
  const subject: string = Form.useWatch([...name, 'subject'], form) ?? '';
  const body: string = Form.useWatch([...name, 'body'], form) ?? '';
  const vars = { app: appName, today: todayIso(), link: window.location.origin, ...SAMPLE[kind] };
  const insert = (v: string) => form.setFieldValue([...name, 'body'], `${body}{{${v}}}`);
  return (
    <Row gutter={16}>
      <Col xs={24} lg={13}>
        <Form.Item name={[...name, 'subject']} label={t('notify.subject')} rules={[{ required: true, max: 200 }]}>
          <Input />
        </Form.Item>
        <Form.Item name={[...name, 'body']} label={t('notify.body')} rules={[{ required: true, max: 4000 }]} style={{ marginBottom: 8 }}>
          <Input.TextArea autoSize={{ minRows: 4, maxRows: 12 }} />
        </Form.Item>
        <div className="notify-vars">
          <span className="muted">{t('notify.vars')}</span>
          {[...NOTIFY_VARS[kind], ...COMMON_VARS].map((v) => (
            <Tag key={v} className="clickable" onClick={() => insert(v)} title={t(`notify.varNames.${v}`, { defaultValue: v })}>{`{{${v}}}`}</Tag>
          ))}
        </div>
        <Button
          size="small"
          icon={<UndoOutlined />}
          style={{ marginTop: 8 }}
          onClick={() => form.setFieldValue(name, { ...form.getFieldValue(name), subject: DEFAULT_RULES[kind].subject, body: DEFAULT_RULES[kind].body })}
        >
          {t('notify.restore')}
        </Button>
      </Col>
      <Col xs={24} lg={11}>
        <div className="muted" style={{ marginBottom: 6 }}>
          {t('notify.preview')}
        </div>
        <div className="mail-preview">
          <div className="mail-preview-subject">{renderTemplate(subject, vars)}</div>
          <div className="mail-preview-body">{renderTemplate(body, vars)}</div>
        </div>
      </Col>
    </Row>
  );
}

export function NotifyPage() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const locale = useLocale();
  const { data: cfg } = useConfig();
  const { data, isLoading } = useNotify();
  const [form] = Form.useForm<NotifySettings>();
  const enabled = Form.useWatch('enabled', form);

  useEffect(() => {
    if (data) form.setFieldsValue(data.settings);
  }, [data, form]);

  const save = useAction(
    async (v: NotifySettings) => {
      const r = await put<NotifyDto>('/notify', v);
      qc.setQueryData(['notify'], r);
    },
    { invalidate: [] },
  );
  const test = useAction(() => post('/notify/test'), { success: t('notify.testSent'), invalidate: ['notify'] });
  const run = useAction(() => post<NotifyRunDto>('/notify/run'), { success: false, invalidate: ['notify', 'statements', 'reminders', 'accounts', 'dashboard'] });

  const dirty = () => form.isFieldsTouched();
  const log = data?.log ?? [];

  return (
    <>
      <PageTop
        title={t('notify.title')}
        extra={
          <Space wrap>
            <Button
              icon={<PlayCircleOutlined />}
              loading={run.isPending}
              onClick={() =>
                run.mutate(undefined, {
                  onSuccess: (r) => void message.success(t('notify.ran', { sent: r.sent, failed: r.failed, autopaid: r.autopaid })),
                })
              }
            >
              {t('notify.runNow')}
            </Button>
            <Button icon={<MailOutlined />} loading={test.isPending} disabled={!data?.mailer} onClick={() => (dirty() ? void message.warning(t('notify.saveFirst')) : test.mutate(undefined))}>
              {t('notify.test')}
            </Button>
            <Button type="primary" icon={<SaveOutlined />} loading={save.isPending} onClick={() => form.submit()}>
              {t('common.save')}
            </Button>
          </Space>
        }
      />
      {data && !data.mailer && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message={t('notify.noMailer')}
          description={
            <ol className="notify-steps">
              {(t('notify.setupSteps', { returnObjects: true }) as unknown as string[]).map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          }
        />
      )}
      <Form form={form} layout="vertical" requiredMark={false} onFinish={(v) => save.mutate(v)} disabled={isLoading}>
        <Card title={t('notify.mail')} style={{ marginBottom: 16 }}>
          <Form.Item name="enabled" valuePropName="checked" label={t('notify.enabled')} extra={t('notify.enabledHint')}>
            <Switch />
          </Form.Item>
          <Row gutter={16}>
            <Col xs={24} md={8}>
              <Form.Item name="from" label={t('notify.from')} extra={t('notify.fromHint')} rules={[{ type: 'email' }, { required: !!enabled }]}>
                <Input placeholder="z-ui@example.com" autoComplete="off" />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="fromName" label={t('notify.fromName')}>
                <Input maxLength={64} />
              </Form.Item>
            </Col>
            <Col xs={24} md={8}>
              <Form.Item name="to" label={t('notify.to')} extra={t('notify.toHint')} rules={[{ type: 'email' }, { required: !!enabled }]}>
                <Input placeholder="me@gmail.com" autoComplete="email" />
              </Form.Item>
            </Col>
          </Row>
        </Card>

        <Card title={t('notify.rules')} style={{ marginBottom: 16 }} styles={{ body: { paddingTop: 8 } }}>
          {NOTIFY_KINDS.map((kind) => (
            <div key={kind} className="notify-rule">
              <div className="notify-rule-head">
                <Form.Item name={['rules', kind, 'enabled']} valuePropName="checked" noStyle>
                  <Switch size="small" aria-label={t(`notify.kinds.${kind}.title`)} />
                </Form.Item>
                <div className="notify-rule-text">
                  <div style={{ fontWeight: 500 }}>{t(`notify.kinds.${kind}.title`)}</div>
                  <div className="muted" style={{ fontSize: 12 }}>
                    {t(`notify.kinds.${kind}.desc`)}
                  </div>
                </div>
                {NOTIFY_HAS_DAYS[kind] ? (
                  <Space size={4} className="notify-days">
                    <Form.Item name={['rules', kind, 'daysBefore']} noStyle>
                      <InputNumber min={0} max={60} size="small" style={{ width: 64 }} aria-label={t('notify.daysBefore')} />
                    </Form.Item>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {t('notify.daysBefore')}
                    </span>
                  </Space>
                ) : (
                  <Form.Item name={['rules', kind, 'daysBefore']} hidden>
                    <InputNumber />
                  </Form.Item>
                )}
              </div>
              <Collapse
                ghost
                size="small"
                items={[{ key: 'tpl', label: t('notify.editContent'), children: <TemplateEditor kind={kind} appName={cfg?.app.name ?? 'Z-UI'} />, forceRender: true }]}
              />
            </div>
          ))}
        </Card>
      </Form>

      <Card title={t('notify.log')} styles={{ body: { padding: 0 } }}>
        <Table<NotificationLogDto>
          rowKey="id"
          size="small"
          dataSource={log}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          scroll={{ x: 640 }}
          locale={{ emptyText: t('notify.noLog') }}
          columns={[
            { key: 'at', title: t('notify.sentAt'), render: (_, l) => <span className="num">{new Date(l.sentAt).toLocaleString(locale)}</span>, width: 180 },
            { key: 'kind', title: t('notify.kind'), render: (_, l) => (NOTIFY_KINDS.includes(l.kind as NotifyKind) ? t(`notify.kinds.${l.kind}.title`) : l.kind) },
            { key: 'subject', title: t('notify.subject'), dataIndex: 'subject' },
            {
              key: 'ok',
              title: t('common.status'),
              render: (_, l) =>
                l.ok ? (
                  <Tag color="success">{t('notify.ok')}</Tag>
                ) : (
                  <Typography.Text type="danger" style={{ fontSize: 12 }}>
                    {l.error}
                  </Typography.Text>
                ),
            },
          ]}
        />
      </Card>
    </>
  );
}
