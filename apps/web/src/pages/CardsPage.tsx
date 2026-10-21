import { ArrowLeftOutlined, CopyOutlined, DeleteOutlined, EditOutlined, EyeInvisibleOutlined, EyeOutlined, InboxOutlined, MoreOutlined, PlusOutlined } from '@ant-design/icons';
import { App, Button, Card, Col, Descriptions, Drawer, Dropdown, Empty, Row, Segmented, Skeleton, Space, Switch, Tabs, Tag, Typography } from 'antd';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { BRAND_META, isExpired, type CardDto, type CardForm } from '@z-ui/shared';
import { del, patch, post } from '../api/client.ts';
import { useAction, useCards, useStatements } from '../api/hooks.ts';
import { BankCard } from '../components/BankCard.tsx';
import { CardModal } from '../components/CardModal.tsx';
import { CardTile } from '../components/CardTile.tsx';
import { useCustomFieldTabs } from '../components/CustomFields.tsx';
import { MoneyText } from '../components/Money.tsx';
import { PageTop } from '../layouts/PanelLayout.tsx';
import { cardLabel, useLookups } from '../lib/format.ts';

/** Physical cards first, each followed by the virtual cards issued under it. */
export function orderCards(list: CardDto[]): { card: CardDto; indent: boolean }[] {
  const ids = new Set(list.map((c) => c.id));
  const out: { card: CardDto; indent: boolean }[] = [];
  for (const c of list.filter((x) => !x.parentCardId || !ids.has(x.parentCardId))) {
    out.push({ card: c, indent: false });
    for (const v of list.filter((x) => x.parentCardId === c.id)) out.push({ card: v, indent: true });
  }
  return out;
}

function CardDrawer({ card, onClose, onEdit, onBack }: { card: CardDto | null; onClose: () => void; onEdit: (c: CardDto) => void; onBack?: () => void }) {
  const { t } = useTranslation();
  const { message, modal } = App.useApp();
  const L = useLookups();
  const { data: statements = [] } = useStatements();
  const [flipped, setFlipped] = useState(false);
  const [pan, setPan] = useState<string | null>(null);
  const [, setParams] = useSearchParams();
  const cfTabs = useCustomFieldTabs('card', card?.extra);
  const reveal = useAction((id: string) => post<{ pan: string }>(`/cards/${id}/reveal`), { success: false, invalidate: [] });
  const archive = useAction((c: CardDto) => patch(`/cards/${c.id}`, { archived: !c.archived }));
  const remove = useAction((c: CardDto) => del(`/cards/${c.id}`), { success: t('common.deleted') });

  // Hide the number again after 30 seconds or when another card opens.
  useEffect(() => {
    if (!pan) return;
    const id = setTimeout(() => setPan(null), 30_000);
    return () => clearTimeout(id);
  }, [pan]);
  useEffect(() => {
    setPan(null);
    setFlipped(false);
  }, [card?.id]);

  if (!card) return <Drawer open={false} />;
  const account = L.acc.get(card.accountId);
  const inst = account ? L.inst.get(account.institutionId) : undefined;
  const parent = card.parentCardId ? L.card.get(card.parentCardId) : undefined;
  const children = L.cards.filter((c) => c.parentCardId === card.id);
  const mine = statements.filter((s) => s.cardId === card.id);

  return (
    <Drawer
      open={!!card}
      onClose={onClose}
      size={480}
      title={
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          {onBack && (
            <Button size="small" icon={<ArrowLeftOutlined />} onClick={onBack}>
              {t('card.back')}
            </Button>
          )}
          {card.nickname ?? `${BRAND_META[card.brand].label} •••• ${card.last4}`}
        </span>
      }
      extra={
        <Space>
          <Button icon={<EditOutlined />} onClick={() => onEdit(card)}>
            {t('common.edit')}
          </Button>
          <Dropdown
            menu={{
              items: [
                { key: 'archive', icon: <InboxOutlined />, label: card.archived ? t('common.unarchive') : t('common.archive'), onClick: () => archive.mutate(card) },
                {
                  key: 'delete',
                  icon: <DeleteOutlined />,
                  danger: true,
                  label: t('common.delete'),
                  onClick: () => modal.confirm({ title: t('common.deleteConfirm'), okButtonProps: { danger: true }, onOk: () => remove.mutateAsync(card).then(onClose) }),
                },
              ],
            }}
          >
            <Button icon={<MoreOutlined />} />
          </Dropdown>
        </Space>
      }
    >
      <div style={{ display: 'flex', justifyContent: 'center' }}>
        <BankCard card={card} bankName={inst?.name} pan={pan} flipped={flipped} onClick={() => setFlipped((f) => !f)} />
      </div>
      <Typography.Paragraph type="secondary" style={{ textAlign: 'center', fontSize: 12, margin: '8px 0 12px' }}>
        {t('card.flip')}
      </Typography.Paragraph>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginBottom: 20 }}>
        {card.hasPan ? (
          pan ? (
            <>
              <Button icon={<EyeInvisibleOutlined />} onClick={() => setPan(null)}>
                {t('card.hide')}
              </Button>
              <Button icon={<CopyOutlined />} onClick={() => navigator.clipboard.writeText(pan).then(() => message.success(t('common.copied')))}>
                {t('common.copy')}
              </Button>
            </>
          ) : (
            <Button icon={<EyeOutlined />} loading={reveal.isPending} onClick={() => reveal.mutate(card.id, { onSuccess: (r) => setPan(r.pan) })}>
              {t('card.reveal')}
            </Button>
          )
        ) : (
          <Tag>{t('card.noPan')}</Tag>
        )}
      </div>
      <Tabs
        items={[
          {
            key: 'info',
            label: t('common.details'),
            children: (
              <Descriptions
                column={1}
                size="small"
                items={[
                  { key: 'acc', label: t('card.account'), children: L.accountLabel(card.accountId) },
                  { key: 'form', label: t('card.form'), children: t(`card.forms.${card.form}`) },
                  { key: 'status', label: t('card.statusLabel'), children: t(`card.statuses.${card.status}`) },
                  ...(parent ? [{ key: 'parent', label: t('card.parent'), children: cardLabel(parent) }] : []),
                  { key: 'brand', label: t('card.brand'), children: BRAND_META[card.brand].label },
                  { key: 'fund', label: t('card.funding'), children: t(`card.fundings.${card.funding}`) },
                  { key: 'bin', label: 'BIN', children: card.bin ?? '—' },
                  {
                    key: 'exp',
                    label: t('card.expiry'),
                    children:
                      card.expMonth && card.expYear ? (
                        <>
                          {String(card.expMonth).padStart(2, '0')}/{card.expYear} {isExpired(card.expMonth, card.expYear) && <Tag color="red">{t('card.expired')}</Tag>}
                        </>
                      ) : (
                        '—'
                      ),
                  },
                  ...(card.spendLimit && account
                    ? [
                        {
                          key: 'limit',
                          label: t('card.spendLimit'),
                          children: (
                            <span>
                              {card.limitPeriod && t(`card.limitPeriods.${card.limitPeriod}`)} <MoneyText minor={card.spendLimit} currency={account.currency} />
                              {card.spent !== null && (
                                <span className="muted">
                                  {' '}
                                  · {t('card.spent')} <MoneyText minor={card.spent} currency={account.currency} />
                                </span>
                              )}
                            </span>
                          ),
                        },
                      ]
                    : []),
                  ...(card.merchant ? [{ key: 'merchant', label: t('card.merchant'), children: card.merchant }] : []),
                  ...(card.funding === 'credit'
                    ? [
                        { key: 'sd', label: t('card.statementDay'), children: card.statementDay ? t('card.dayN', { n: card.statementDay }) : '—' },
                        { key: 'dd', label: t('card.dueDay'), children: card.dueDay ? t('card.dayN', { n: card.dueDay }) : '—' },
                        {
                          key: 'autopay',
                          label: t('autopay.title'),
                          children: card.autopayAccountId
                            ? `${L.accountLabel(card.autopayAccountId)}${card.autopayCurrency ? ` (${card.autopayCurrency})` : ''} · ${t(`autopay.modes.${card.autopayMode ?? 'full'}`)}`
                            : t('autopay.off'),
                        },
                      ]
                    : []),
                  { key: 'note', label: t('common.note'), children: card.note || '—' },
                ]}
              />
            ),
          },
          ...(children.length
            ? [
                {
                  key: 'virtual',
                  label: `${t('card.forms.virtual')} (${children.length})`,
                  children: children.map((c) => <CardTile key={c.id} card={c} onClick={() => setParams({ card: c.id })} />),
                },
              ]
            : []),
          ...(card.funding === 'credit'
            ? [
                {
                  key: 'st',
                  label: t('card.statements'),
                  children: mine.length ? (
                    mine.map((s) => (
                      <div key={s.id} className="row-item">
                        <div className="row-main">
                          <div className="row-title">{s.dueDate}</div>
                          <div className="row-sub">{t(`statement.statuses.${s.status}`)}</div>
                        </div>
                        <MoneyText minor={s.statementAmount} currency={s.currency} />
                      </div>
                    ))
                  ) : (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} />
                  ),
                },
              ]
            : []),
          ...cfTabs,
        ]}
      />
    </Drawer>
  );
}

export function CardsPage() {
  const { t } = useTranslation();
  const { data: cards, isLoading } = useCards();
  const L = useLookups();
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const [showArchived, setShowArchived] = useState(false);
  const [formFilter, setFormFilter] = useState<'all' | CardForm>('all');
  const [modal, setModal] = useState<{ open: boolean; editing: CardDto | null }>({ open: false, editing: null });
  const open = (cards ?? []).find((c) => c.id === params.get('card')) ?? null;
  // Opened from another page (e.g. an account's cards): offer a way back there.
  const from = (location.state as { from?: string } | null)?.from;

  const groups = useMemo(() => {
    const list = (cards ?? []).filter((c) => (showArchived || !c.archived) && (formFilter === 'all' || c.form === formFilter));
    const byAccount = new Map<string, CardDto[]>();
    for (const c of list) byAccount.set(c.accountId, [...(byAccount.get(c.accountId) ?? []), c]);
    return [...byAccount].map(([accountId, items]) => ({ accountId, items: formFilter === 'all' ? orderCards(items) : items.map((card) => ({ card, indent: false })) }));
  }, [cards, showArchived, formFilter]);

  return (
    <>
      <PageTop
        title={t('nav.cards')}
        extra={
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setModal({ open: true, editing: null })} disabled={L.accounts.length === 0}>
            {t('card.add')}
          </Button>
        }
      />
      <div className="filter-row">
        <Segmented
          value={formFilter}
          onChange={(v) => setFormFilter(v as typeof formFilter)}
          options={[
            { value: 'all', label: t('common.all') },
            { value: 'physical', label: t('card.forms.physical') },
            { value: 'virtual', label: t('card.forms.virtual') },
          ]}
        />
        <label className="muted" style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
          <Switch size="small" checked={showArchived} onChange={setShowArchived} />
          {t('common.archived')}
        </label>
      </div>
      {isLoading && <Skeleton active />}
      {!isLoading && groups.length === 0 && (
        <Card>
          <Empty />
        </Card>
      )}
      <Row gutter={[16, 16]}>
        <AnimatePresence initial={false}>
          {groups.map(({ accountId, items }, i) => (
            <Col key={accountId} xs={24} lg={12} xxl={8}>
              <motion.div layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0, transition: { delay: i * 0.04 } }} exit={{ opacity: 0 }}>
                <Card
                  size="small"
                  title={L.accountLabel(accountId)}
                  extra={<span className="muted">{t('account.cardsN', { n: items.length })}</span>}
                  styles={{ body: { padding: 6 } }}
                >
                  {items.map(({ card, indent }) => (
                    <CardTile key={card.id} card={card} indent={indent} onClick={() => setParams({ card: card.id }, { state: location.state })} />
                  ))}
                </Card>
              </motion.div>
            </Col>
          ))}
        </AnimatePresence>
      </Row>
      <CardModal open={modal.open} editing={modal.editing} onClose={() => setModal({ open: false, editing: null })} />
      <CardDrawer
        card={open}
        onClose={() => (from ? navigate(from) : setParams({}))}
        onBack={from ? () => navigate(from) : undefined}
        onEdit={(c) => setModal({ open: true, editing: c })}
      />
    </>
  );
}
