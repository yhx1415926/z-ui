import { useTranslation } from 'react-i18next';
import {
  BRAND_META,
  formatPan,
  isExpired,
  type CardBrand,
  type CardForm,
  type CardFunding,
  type CardStatus,
  type CardTheme,
} from '@z-ui/shared';

export interface CardFace {
  brand: CardBrand;
  funding: CardFunding;
  last4: string;
  bin?: string | null;
  expMonth?: number | null;
  expYear?: number | null;
  holderName?: string | null;
  nickname?: string | null;
  theme: CardTheme;
  form?: CardForm;
  status?: CardStatus;
}

function BrandMark({ brand }: { brand: CardBrand }) {
  if (brand === 'mastercard' || brand === 'maestro') {
    return (
      <svg className="card-brand-svg" viewBox="0 0 46 28" aria-label={BRAND_META[brand].label}>
        <circle cx="16" cy="14" r="13" fill="#eb001b" />
        <circle cx="30" cy="14" r="13" fill={brand === 'maestro' ? '#00a2e5' : '#f79e1b'} />
        <path d="M23 3.1a13 13 0 0 1 0 21.8 13 13 0 0 1 0-21.8z" fill={brand === 'maestro' ? '#7375cf' : '#ff5f00'} />
      </svg>
    );
  }
  const text: Partial<Record<CardBrand, string>> = {
    visa: 'VISA',
    amex: 'AMEX',
    unionpay: 'UnionPay',
    jcb: 'JCB',
    discover: 'DISCOVER',
    diners: 'Diners',
  };
  return <span className="card-brand">{text[brand] ?? ''}</span>;
}

/** Placeholder digits shaped like the brand's grouping: "4242 42•• •••• 4242". */
function maskedNumber(brand: CardBrand, last4: string, bin?: string | null): string {
  const len = brand === 'amex' ? 15 : brand === 'diners' ? 14 : 16;
  const prefix = (bin ?? '').slice(0, 6);
  const middle = '•'.repeat(Math.max(0, len - prefix.length - 4));
  return formatPan(prefix + middle + last4, brand);
}

/**
 * Stripe-like card face with a 3D flip. All sizes are relative to the card's own width
 * (container query units), so it works as a thumbnail and as a large card, and long
 * 19-digit UnionPay numbers never overflow. The full number only shows when `pan` is passed.
 */
export function BankCard({
  card,
  bankName,
  pan,
  securityCode,
  flipped = false,
  onClick,
  width,
}: {
  card: CardFace;
  bankName?: string;
  pan?: string | null;
  /** Shown in the signature strip on the back; fetched only once the card is turned over. */
  securityCode?: string | null;
  flipped?: boolean;
  onClick?: () => void;
  width?: number;
}) {
  const { t } = useTranslation();
  const exp =
    card.expMonth && card.expYear ? `${String(card.expMonth).padStart(2, '0')}/${String(card.expYear).slice(-2)}` : '••/••';
  const expired = card.expMonth && card.expYear ? isExpired(card.expMonth, card.expYear) : false;
  const number = pan ? formatPan(pan, card.brand) : maskedNumber(card.brand, card.last4, card.bin);
  const cls = ['bank-card', flipped && 'flipped', card.form === 'virtual' && 'is-virtual', card.status && card.status !== 'active' && `is-${card.status}`]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="bank-card-wrap" onClick={onClick} style={width ? { width, maxWidth: width } : undefined}>
      <div className={cls}>
        <div className={`bank-card-face card-theme-${card.theme}`}>
          <div className="card-top">
            <div style={{ minWidth: 0 }}>
              <div className="card-bank">{bankName ?? BRAND_META[card.brand].label}</div>
              {card.nickname && <div className="card-nick">{card.nickname}</div>}
            </div>
            <div className="card-label card-kind">
              {card.form === 'virtual' ? <span className="card-virtual-badge">VIRTUAL</span> : t(`card.fundings.${card.funding}`)}
            </div>
          </div>
          <div className="card-chip" />
          <div className="card-number" data-long={number.length > 19 ? '' : undefined}>
            {number}
          </div>
          <div className="card-bottom">
            <div style={{ display: 'flex', gap: '5cqw', minWidth: 0 }}>
              <div style={{ minWidth: 0 }}>
                <div className="card-label">{t('card.holder')}</div>
                <div className="card-value card-holder">{card.holderName || '—'}</div>
              </div>
              <div>
                <div className="card-label">{t('card.expiry')}</div>
                <div className="card-value" style={expired ? { color: '#ffccc7' } : undefined}>
                  {exp}
                </div>
              </div>
            </div>
            <BrandMark brand={card.brand} />
          </div>
          {card.status && card.status !== 'active' && <div className="card-stamp">{t(`card.statuses.${card.status}`)}</div>}
        </div>
        <div className={`bank-card-face bank-card-back card-theme-${card.theme}`}>
          <div className="card-stripe" />
          <div className="card-sign">
            <span className="card-sign-label">CVV / PIN</span>
            <span className="card-sign-code">{securityCode ?? '•••'}</span>
          </div>
          <div className="card-bottom">
            <div>
              <div className="card-label">BIN</div>
              <div className="card-value">{card.bin ?? '—'}</div>
            </div>
            <BrandMark brand={card.brand} />
          </div>
        </div>
      </div>
    </div>
  );
}
