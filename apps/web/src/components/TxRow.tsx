import { RetweetOutlined, SlidersOutlined } from '@ant-design/icons';
import { Tag } from 'antd';
import { useTranslation } from 'react-i18next';
import type { TransactionDto } from '@z-ui/shared';
import { colorFor, useLookups } from '../lib/format.ts';
import { MoneyText, TxExtras } from './Money.tsx';

/** Compact transaction line used on the dashboard and in account details. */
export function TxRow({ tx, onClick }: { tx: TransactionDto; onClick?: () => void }) {
  const { t } = useTranslation();
  const L = useLookups();
  const cat = tx.categoryId ? L.cat.get(tx.categoryId) : undefined;
  const title =
    tx.type === 'transfer'
      ? tx.amount < 0
        ? t('tx.transferTo', { name: L.accountLabel(tx.counterpartAccountId) })
        : t('tx.transferFrom', { name: L.accountLabel(tx.counterpartAccountId) })
      : tx.counterparty || cat?.name || t(`tx.types.${tx.type}`);
  const color = tx.type === 'transfer' ? '#8c8c8c' : tx.type === 'adjustment' ? '#d48806' : (cat?.color ?? colorFor(title));
  return (
    <div className={`row-item ${onClick ? 'clickable' : ''}`} onClick={onClick}>
      <span className="avatar-icon" style={{ background: color }}>
        {tx.type === 'transfer' ? <RetweetOutlined /> : tx.type === 'adjustment' ? <SlidersOutlined /> : (cat?.name ?? title).slice(0, 1)}
      </span>
      <div className="row-main">
        <div className="row-title">{title}</div>
        <div className="row-sub">
          {tx.occurredAt} · {L.accountLabel(tx.accountId)}
          {tx.note ? ` · ${tx.note}` : ''}
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <MoneyText minor={tx.amount} currency={tx.currency} signed colored style={{ fontWeight: 600 }} />
        <TxExtras tx={tx} />
        <div>
          {tx.tagIds.slice(0, 2).map((id) => (
            <Tag key={id} style={{ marginInlineEnd: 0, marginInlineStart: 4, fontSize: 11 }} color={L.tag.get(id)?.color ?? undefined}>
              {L.tag.get(id)?.name}
            </Tag>
          ))}
        </div>
      </div>
    </div>
  );
}
