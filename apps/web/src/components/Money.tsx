import { InputNumber } from 'antd';
import { animate, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { fromMinor, toMinor } from '@z-ui/shared';
import { useDecimals, useMoney } from '../lib/format.ts';

/** Number that eases from its previous value to the new one (balances, totals). */
export function AnimatedNumber({ value, format, duration = 0.7 }: { value: number; format: (n: number) => string; duration?: number }) {
  const reduce = useReducedMotion();
  const [shown, setShown] = useState(value);
  const prev = useRef(value);
  useEffect(() => {
    if (reduce || prev.current === value) {
      setShown(value);
      prev.current = value;
      return;
    }
    const controls = animate(prev.current, value, {
      duration,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => setShown(Math.round(v)),
    });
    prev.current = value;
    return () => controls.stop();
  }, [value, duration, reduce]);
  return <span className="num">{format(shown)}</span>;
}

/** Signed amount with income/expense coloring. */
export function MoneyText({
  minor,
  currency,
  signed = false,
  colored = false,
  animated = false,
  style,
}: {
  minor: number;
  currency: string;
  signed?: boolean;
  colored?: boolean;
  animated?: boolean;
  style?: CSSProperties;
}) {
  const money = useMoney();
  const fmt = (n: number) => money(n, currency, { signDisplay: signed ? 'exceptZero' : 'auto' });
  const cls = colored ? (minor > 0 ? 'income' : minor < 0 ? 'expense' : '') : '';
  return (
    <span className={`num ${cls}`} style={style}>
      {animated ? <AnimatedNumber value={minor} format={fmt} /> : fmt(minor)}
    </span>
  );
}

/** "≈ US$20.00" under an amount paid in another currency (foreign-currency charge). */
export function OriginalAmount({ tx }: { tx: { originalAmount: number | null; originalCurrency: string | null } }) {
  const money = useMoney();
  if (tx.originalAmount === null || !tx.originalCurrency) return null;
  return (
    <div className="muted num" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
      {money(tx.originalAmount, tx.originalCurrency)}
    </div>
  );
}

/**
 * Amount input bound to integer minor units. Uses string mode so 0.1 + 0.2 style float
 * errors never reach the stored value.
 */
export function MoneyInput({
  id,
  value,
  onChange,
  currency,
  allowNegative = false,
  placeholder,
  autoFocus,
  style,
}: {
  /** Injected by Form.Item so the label points at the input. */
  id?: string;
  value?: number | null;
  onChange?: (v: number | null) => void;
  currency: string;
  allowNegative?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  style?: CSSProperties;
}) {
  const decimals = useDecimals()(currency);
  const [text, setText] = useState<string | null>(value === null || value === undefined ? null : fromMinor(value, decimals));
  const lastEmitted = useRef<number | null | undefined>(value);

  // Sync when the form sets a value from outside (e.g. editing another record).
  useEffect(() => {
    if (value !== lastEmitted.current) {
      setText(value === null || value === undefined ? null : fromMinor(value, decimals));
      lastEmitted.current = value;
    }
  }, [value, decimals]);

  return (
    <InputNumber<string>
      id={id}
      stringMode
      value={text}
      precision={decimals}
      min={allowNegative ? undefined : '0'}
      style={{ width: '100%', ...style }}
      placeholder={placeholder}
      autoFocus={autoFocus}
      suffix={<span className="muted">{currency}</span>}
      onChange={(v) => {
        setText(v);
        const minor = v === null || v === '' ? null : toMinor(v, decimals);
        lastEmitted.current = minor;
        onChange?.(minor);
      }}
    />
  );
}
