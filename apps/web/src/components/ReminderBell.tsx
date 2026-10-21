import {
  BellOutlined,
  CloseOutlined,
  CreditCardOutlined,
  ExclamationCircleOutlined,
  FieldTimeOutlined,
  RiseOutlined,
  ScheduleOutlined,
  ThunderboltOutlined,
  WarningOutlined,
} from '@ant-design/icons';
import { Badge, Button, Empty, Popover, Tag, Tooltip } from 'antd';
import { AnimatePresence, motion } from 'motion/react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router';
import type { ReminderDto, ReminderKind } from '@z-ui/shared';
import { post } from '../api/client.ts';
import { useAction, useReminders } from '../api/hooks.ts';
import { useMoney } from '../lib/format.ts';

const ICONS: Record<ReminderKind, ReactNode> = {
  bill: <ScheduleOutlined />,
  statement: <CreditCardOutlined />,
  card_due: <FieldTimeOutlined />,
  card_expiry: <WarningOutlined />,
  over_limit: <ExclamationCircleOutlined />,
  autopay_low: <ThunderboltOutlined />,
  price_alert: <RiseOutlined />,
};

export const SEVERITY_COLOR = { overdue: 'red', soon: 'orange', upcoming: 'blue' } as const;

export function useDueText() {
  const { t } = useTranslation();
  return (r: Pick<ReminderDto, 'daysLeft'>) =>
    r.daysLeft < 0 ? t('common.daysAgo', { n: -r.daysLeft }) : r.daysLeft === 0 ? t('common.dueToday') : t('common.daysLeft', { n: r.daysLeft });
}

export function ReminderList({ items, compact = false }: { items: ReminderDto[]; compact?: boolean }) {
  const { t } = useTranslation();
  const money = useMoney();
  const navigate = useNavigate();
  const due = useDueText();
  const dismiss = useAction((key: string) => post('/reminders/dismiss', { key }), { success: false, invalidate: ['reminders'] });
  if (items.length === 0) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('reminders.empty')} />;
  const target = (r: ReminderDto) =>
    r.kind === 'bill'
      ? '/bills'
      : r.kind === 'card_expiry'
        ? '/cards'
        : r.kind === 'over_limit'
          ? `/accounts?account=${r.refId}`
          : r.kind === 'price_alert'
            ? `/invest?tab=watch&symbol=${r.refId}`
            : '/statements';
  return (
    <div>
      <AnimatePresence initial={false}>
        {items.map((r) => (
          <motion.div
            key={r.key}
            layout
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0, transition: { duration: 0.2 } }}
          >
            <div className="row-item clickable" onClick={() => navigate(target(r))}>
              <span className="avatar-icon" style={{ background: `var(--ant-color-${r.severity === 'overdue' ? 'error' : r.severity === 'soon' ? 'warning' : 'primary'})`, width: 32, height: 32, flexBasis: 32, fontSize: 15 }}>
                {ICONS[r.kind]}
              </span>
              <div className="row-main">
                <div className="row-title">{r.title}</div>
                <div className="row-sub">
                  {t(`reminders.kinds.${r.kind}`)} · {r.date}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                {r.amount !== null && r.currency && <div className="num" style={{ fontWeight: 500 }}>{money(r.amount, r.currency)}</div>}
                <Tag color={SEVERITY_COLOR[r.severity]} style={{ marginInlineEnd: 0 }}>
                  {r.kind === 'over_limit' ? t('reminders.overTag') : r.kind === 'price_alert' ? t('reminders.firedTag') : due(r)}
                </Tag>
              </div>
              {!compact && (
                <Tooltip title={t('reminders.dismiss')}>
                  <Button
                    type="text"
                    size="small"
                    icon={<CloseOutlined />}
                    onClick={(e) => {
                      e.stopPropagation();
                      dismiss.mutate(r.key);
                    }}
                  />
                </Tooltip>
              )}
            </div>
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
  );
}

export function ReminderBell() {
  const { t } = useTranslation();
  const { data = [] } = useReminders();
  const urgent = data.filter((r) => r.severity !== 'upcoming').length;
  return (
    <Popover
      trigger="click"
      placement="bottomRight"
      title={t('reminders.title')}
      content={
        <div style={{ width: 340, maxHeight: 420, overflowY: 'auto' }}>
          <ReminderList items={data} />
        </div>
      }
    >
      <Badge count={urgent} size="small" offset={[-4, 4]}>
        <button className="icon-btn" aria-label={t('reminders.title')} style={{ width: 36, height: 36, fontSize: 18 }}>
          <BellOutlined />
        </button>
      </Badge>
    </Popover>
  );
}
