import { CheckCircleFilled } from '@ant-design/icons';
import { Checkbox, Col, Form, Input, InputNumber, Modal, Row, Segmented, Select, Space, Tag } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AUTOPAY_MODES,
  BRAND_META,
  CARD_BRANDS,
  CARD_FUNDING,
  CARD_STATUSES,
  CARD_THEMES,
  checkPan,
  detectBrand,
  formatExpiryInput,
  formatPan,
  LIMIT_PERIODS,
  maxPanLength,
  normalizePan,
  panInputState,
  parseExpiry,
  type AccountDto,
  type AutopayMode,
  type CardBrand,
  type CardDto,
  type CardForm,
  type CardFunding,
  type CardStatus,
  type CardTheme,
  type LimitPeriod,
} from '@z-ui/shared';
import { patch, post } from '../api/client.ts';
import { useAction } from '../api/hooks.ts';
import { cardLabel, useAccountOptions, useLookups } from '../lib/format.ts';
import { BankCard } from './BankCard.tsx';
import { CustomFieldInputs } from './CustomFields.tsx';
import { MoneyInput } from './Money.tsx';

type PanMode = 'keep' | 'full' | 'last4';

interface CardFormValues {
  accountId: string;
  form: CardForm;
  parentCardId?: string | null;
  status: CardStatus;
  panMode: PanMode;
  pan?: string;
  /** New security code (never pre-filled: the stored one stays on the server). */
  cvv?: string;
  forgetCvv?: boolean;
  last4?: string;
  bin?: string;
  brand?: CardBrand;
  funding: CardFunding;
  expiry?: string;
  holderName?: string;
  nickname?: string;
  statementDay?: number | null;
  dueDay?: number | null;
  autopayAccountId?: string | null;
  autopayCurrency?: string | null;
  autopayMode?: AutopayMode | null;
  spendLimit?: number | null;
  limitPeriod?: LimitPeriod | null;
  singleUse?: boolean;
  merchant?: string;
  theme: CardTheme;
  note?: string;
  extra?: Record<string, unknown>;
}

/** Stripe-style "MM / YY" field: the slash appears by itself once the month is typed. */
export function ExpiryInput({ id, value, onChange }: { id?: string; value?: string; onChange?: (v: string) => void }) {
  const { t } = useTranslation();
  return (
    <Input
      id={id}
      value={value ?? ''}
      inputMode="numeric"
      autoComplete="cc-exp"
      placeholder={t('card.expiryPlaceholder')}
      maxLength={7}
      onChange={(e) => onChange?.(formatExpiryInput(value ?? '', e.target.value))}
    />
  );
}

function ThemePicker({ value, onChange }: { value?: CardTheme; onChange?: (v: CardTheme) => void }) {
  return (
    <Space wrap size={8}>
      {CARD_THEMES.map((th) => (
        <div key={th} className={`theme-swatch card-theme-${th} ${value === th ? 'selected' : ''}`} onClick={() => onChange?.(th)} title={th} />
      ))}
    </Space>
  );
}

const twoDigits = (n: number) => String(n).padStart(2, '0');
export function CardModal({
  open,
  editing,
  defaultAccountId,
  defaultForm = 'physical',
  onClose,
}: {
  open: boolean;
  editing: CardDto | null;
  defaultAccountId?: string;
  defaultForm?: CardForm;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [form] = Form.useForm<CardFormValues>();
  const L = useLookups();
  const accountOptions = useAccountOptions();
  const v = Form.useWatch([], form) as Partial<CardFormValues> | undefined;
  const [panBlurred, setPanBlurred] = useState(false);

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    setPanBlurred(false);
    if (editing) {
      form.setFieldsValue({
        ...editing,
        panMode: editing.hasPan ? 'keep' : 'last4',
        last4: editing.last4,
        bin: editing.bin ?? undefined,
        nickname: editing.nickname ?? undefined,
        holderName: editing.holderName ?? undefined,
        merchant: editing.merchant ?? undefined,
        note: editing.note ?? undefined,
        expiry: editing.expMonth && editing.expYear ? `${twoDigits(editing.expMonth)} / ${twoDigits(editing.expYear % 100)}` : '',
        autopayMode: editing.autopayMode ?? 'full',
      });
    } else {
      form.setFieldsValue({ accountId: defaultAccountId, form: defaultForm, status: 'active', panMode: 'full', funding: 'debit', theme: 'midnight', limitPeriod: 'month', autopayMode: 'full', extra: {} });
    }
  }, [open, editing, defaultAccountId, defaultForm, form]);

  const mode = v?.panMode ?? 'full';
  const isVirtual = (v?.form ?? 'physical') === 'virtual';
  const pan = panInputState(v?.pan ?? '', panBlurred);
  const previewBrand: CardBrand =
    mode === 'full' && pan.digits ? pan.brand : (v?.brand ?? (v?.bin ? detectBrand(v.bin) : (editing?.brand ?? 'other')));
  const account = v?.accountId ? L.acc.get(v.accountId) : undefined;
  const expiry = parseExpiry(v?.expiry ?? '');
  // Automatic repayment comes from another account than the card's own.
  const notOwn = useCallback((a: AccountDto) => a.id !== v?.accountId, [v?.accountId]);
  const autopayOptions = useAccountOptions(notOwn);
  const autopayAccount = v?.autopayAccountId ? L.acc.get(v.autopayAccountId) : undefined;
  const parentOptions = useMemo(() => {
    const physical = L.cards.filter((c) => c.form === 'physical' && c.status !== 'closed' && c.id !== editing?.id);
    const sameAccount = physical.filter((c) => c.accountId === v?.accountId);
    return (sameAccount.length ? sameAccount : physical).map((c) => ({ value: c.id, label: cardLabel(c) }));
  }, [L.cards, v?.accountId, editing?.id]);

  const save = useAction(async (f: CardFormValues) => {
    const exp = f.expiry ? parseExpiry(f.expiry) : null;
    const body: Record<string, unknown> = {
      accountId: f.accountId,
      form: f.form,
      parentCardId: f.form === 'virtual' ? (f.parentCardId ?? null) : null,
      status: f.status,
      spendLimit: f.spendLimit || null,
      limitPeriod: f.spendLimit ? (f.limitPeriod ?? 'month') : null,
      singleUse: f.form === 'virtual' ? !!f.singleUse : false,
      merchant: f.merchant || null,
      funding: f.funding,
      nickname: f.nickname || null,
      holderName: f.holderName || null,
      expMonth: exp?.month ?? null,
      expYear: exp?.year ?? null,
      statementDay: f.funding === 'credit' ? (f.statementDay ?? null) : null,
      dueDay: f.funding === 'credit' ? (f.dueDay ?? null) : null,
      autopayAccountId: f.funding === 'credit' ? (f.autopayAccountId ?? null) : null,
      autopayCurrency: f.funding === 'credit' && f.autopayAccountId ? (f.autopayCurrency ?? null) : null,
      autopayMode: f.funding === 'credit' && f.autopayAccountId ? (f.autopayMode ?? 'full') : null,
      theme: f.theme,
      note: f.note || null,
      extra: f.extra ?? {},
    };
    if (f.panMode === 'full') body.pan = f.pan;
    // Left blank: the stored code stays as it is.
    if (f.forgetCvv) body.cvv = null;
    else if (f.cvv) body.cvv = f.cvv;
    if (f.panMode === 'last4') {
      Object.assign(body, { last4: f.last4, bin: f.bin || null, brand: f.brand ?? (f.bin ? detectBrand(f.bin) : 'other') });
      if (editing?.hasPan) body.pan = null;
    }
    if (editing) await patch(`/cards/${editing.id}`, body);
    else await post('/cards', body);
    onClose();
  });

  const submit = (f: CardFormValues) => {
    if (f.panMode === 'full' && !checkPan(f.pan ?? '').ok) {
      setPanBlurred(true); // reveal the error under the field
      return;
    }
    save.mutate(f);
  };

  return (
    <Modal open={open} title={editing ? t('card.edit') : t('card.add')} onCancel={onClose} onOk={() => form.submit()} confirmLoading={save.isPending} destroyOnHidden width={560}>
      <div style={{ display: 'flex', justifyContent: 'center', margin: '8px 0 18px' }}>
        <BankCard
          width={300}
          bankName={account ? L.inst.get(account.institutionId)?.name : undefined}
          pan={mode === 'full' && pan.digits.length >= 4 ? pan.digits : null}
          card={{
            brand: previewBrand,
            funding: v?.funding ?? 'debit',
            last4: mode === 'full' ? pan.digits.slice(-4).padStart(4, '•') : (v?.last4 ?? editing?.last4 ?? '••••'),
            bin: mode === 'last4' ? v?.bin : editing?.bin,
            expMonth: expiry?.month ?? null,
            expYear: expiry?.year ?? null,
            holderName: v?.holderName,
            nickname: v?.nickname,
            theme: v?.theme ?? 'midnight',
            form: v?.form,
            status: v?.status,
          }}
        />
      </div>
      <Form form={form} layout="vertical" requiredMark={false} onFinish={submit}>
        <Row gutter={12}>
          <Col span={14}>
            <Form.Item name="accountId" label={t('card.account')} rules={[{ required: true }]}>
              <Select options={accountOptions} showSearch={{ optionFilterProp: 'label' }} />
            </Form.Item>
          </Col>
          <Col span={10}>
            <Form.Item name="form" label={t('card.form')}>
              <Segmented block options={(['physical', 'virtual'] as const).map((f) => ({ value: f, label: t(`card.forms.${f}`) }))} />
            </Form.Item>
          </Col>
        </Row>
        <Form.Item name="panMode" style={{ marginBottom: 12 }}>
          <Segmented
            block
            options={[
              ...(editing?.hasPan ? [{ value: 'keep', label: t('card.keepPan', { last4: editing.last4 }) }] : []),
              { value: 'full', label: t('card.fullNumber') },
              { value: 'last4', label: t('card.onlyLast4') },
            ]}
          />
        </Form.Item>
        {mode === 'full' && (
          <Form.Item
            name="pan"
            label={t('card.number')}
            extra={pan.error || pan.warning ? undefined : t('card.numberHint')}
            validateStatus={pan.error ? 'error' : pan.warning ? 'warning' : undefined}
            help={pan.error ? t(pan.error === 'luhn' ? 'card.luhn' : 'card.lengthError') : pan.warning ? t('card.luhnWarn') : undefined}
            normalize={(val: string) => {
              const digits = normalizePan(val ?? '').replace(/\D/g, '');
              return formatPan(digits.slice(0, maxPanLength(detectBrand(digits))));
            }}
          >
            <Input
              inputMode="numeric"
              autoComplete="cc-number"
              placeholder="4242 4242 4242 4242"
              onFocus={() => setPanBlurred(false)}
              onBlur={() => setPanBlurred(true)}
              // The suffix element is always rendered: adding/removing it re-mounts the input and drops focus.
              suffix={
                <span className="pan-suffix">
                  {pan.digits && <Tag style={{ marginInlineEnd: 0 }}>{BRAND_META[previewBrand].label}</Tag>}
                  {pan.valid && !pan.warning && <CheckCircleFilled style={{ color: 'var(--ant-color-success)', marginLeft: 6 }} />}
                </span>
              }
            />
          </Form.Item>
        )}
        {mode === 'last4' && (
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="last4" label={t('card.last4')} rules={[{ required: true, pattern: /^\d{4}$/ }]}>
                <Input maxLength={4} inputMode="numeric" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="bin" label={t('card.bin')} rules={[{ pattern: /^\d{6}$/, message: t('card.binHint') }]}>
                <Input maxLength={6} inputMode="numeric" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="brand" label={t('card.brand')}>
                <Select allowClear options={CARD_BRANDS.map((b) => ({ value: b, label: BRAND_META[b].label }))} />
              </Form.Item>
            </Col>
          </Row>
        )}
        <Row gutter={12}>
          <Col span={8}>
            <Form.Item name="funding" label={t('card.funding')} rules={[{ required: true }]}>
              <Select options={CARD_FUNDING.map((f) => ({ value: f, label: t(`card.fundings.${f}`) }))} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              name="expiry"
              label={t('card.expiry')}
              rules={[{ validator: (_, val) => (!val || parseExpiry(val) ? Promise.resolve() : Promise.reject(new Error('MM / YY'))) }]}
              validateTrigger="onBlur"
            >
              <ExpiryInput />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="holderName" label={t('card.holder')}>
              <Input maxLength={64} style={{ textTransform: 'uppercase' }} autoComplete="cc-name" />
            </Form.Item>
          </Col>
        </Row>
        <Row gutter={12} align="middle">
          <Col span={8}>
            <Form.Item
              name="cvv"
              label={t('card.cvv')}
              rules={[{ pattern: /^(\d{3}|\d{4}|\d{6})$/, message: t('card.cvvHint') }]}
              normalize={(val: string) => (val ?? '').replace(/\D/g, '').slice(0, 6)}
            >
              <Input.Password
                inputMode="numeric"
                maxLength={6}
                autoComplete="off"
                placeholder={editing?.hasCvv ? t('card.cvvKept') : t('common.optional')}
                disabled={!!v?.forgetCvv}
              />
            </Form.Item>
          </Col>
          <Col span={16}>
            {editing?.hasCvv ? (
              <Form.Item name="forgetCvv" valuePropName="checked" style={{ marginBottom: 0 }}>
                <Checkbox>{t('card.forgetCvv')}</Checkbox>
              </Form.Item>
            ) : (
              <span className="muted" style={{ fontSize: 12 }}>
                {t('card.cvvHelp')}
              </span>
            )}
          </Col>
        </Row>
        {isVirtual && (
          <>
            <Row gutter={12}>
              <Col span={12}>
                <Form.Item name="parentCardId" label={t('card.parent')}>
                  <Select allowClear options={parentOptions} placeholder={t('common.optional')} />
                </Form.Item>
              </Col>
              <Col span={12}>
                <Form.Item name="merchant" label={t('card.merchant')}>
                  <Input maxLength={64} placeholder="Netflix / OpenAI" />
                </Form.Item>
              </Col>
            </Row>
            <Row gutter={12} align="bottom">
              <Col span={10}>
                <Form.Item name="spendLimit" label={t('card.spendLimit')}>
                  <MoneyInput currency={account?.currency ?? '—'} placeholder={t('common.optional')} />
                </Form.Item>
              </Col>
              <Col span={7}>
                <Form.Item name="limitPeriod" label=" ">
                  <Select options={LIMIT_PERIODS.map((p) => ({ value: p, label: t(`card.limitPeriods.${p}`) }))} />
                </Form.Item>
              </Col>
              <Col span={7}>
                <Form.Item name="singleUse" valuePropName="checked" label=" ">
                  <Checkbox>{t('card.singleUse')}</Checkbox>
                </Form.Item>
              </Col>
            </Row>
          </>
        )}
        {v?.funding === 'credit' && (
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="statementDay" label={t('card.statementDay')}>
                <InputNumber min={1} max={31} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="dueDay" label={t('card.dueDay')}>
                <InputNumber min={1} max={31} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
          </Row>
        )}
        {v?.funding === 'credit' && (
          <>
            <Form.Item label={t('autopay.title')} htmlFor="autopayAccountId" extra={t('autopay.hint')} style={{ marginBottom: v.autopayAccountId ? 8 : undefined }}>
              <Space.Compact block>
                <Form.Item name="autopayAccountId" noStyle>
                  <Select
                    allowClear
                    placeholder={t('autopay.off')}
                    options={autopayOptions}
                    showSearch={{ optionFilterProp: 'label' }}
                    onChange={() => form.setFieldValue('autopayCurrency', null)}
                  />
                </Form.Item>
                {autopayAccount && autopayAccount.currencies.length > 1 && (
                  <Form.Item name="autopayCurrency" noStyle>
                    <Select
                      style={{ width: 120, flex: '0 0 auto' }}
                      allowClear
                      placeholder={t('autopay.autoCurrency')}
                      options={autopayAccount.currencies.map((c) => ({ value: c.currency, label: c.currency }))}
                    />
                  </Form.Item>
                )}
              </Space.Compact>
            </Form.Item>
            {v.autopayAccountId && (
              <Form.Item name="autopayMode">
                <Segmented options={AUTOPAY_MODES.map((m) => ({ value: m, label: t(`autopay.modes.${m}`) }))} />
              </Form.Item>
            )}
          </>
        )}
        <Row gutter={12}>
          <Col span={editing ? 14 : 24}>
            <Form.Item name="nickname" label={t('card.nickname')}>
              <Input maxLength={64} />
            </Form.Item>
          </Col>
          {editing && (
            <Col span={10}>
              <Form.Item name="status" label={t('card.statusLabel')}>
                <Select options={CARD_STATUSES.map((s) => ({ value: s, label: t(`card.statuses.${s}`) }))} />
              </Form.Item>
            </Col>
          )}
        </Row>
        <Form.Item name="theme" label={t('card.theme')}>
          <ThemePicker />
        </Form.Item>
        <Form.Item name="note" label={t('common.note')}>
          <Input.TextArea autoSize={{ minRows: 1, maxRows: 4 }} />
        </Form.Item>
        <CustomFieldInputs entity="card" />
      </Form>
    </Modal>
  );
}
