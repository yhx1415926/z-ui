import {
  AppstoreOutlined,
  BarChartOutlined,
  BulbOutlined,
  CloseOutlined,
  CreditCardOutlined,
  DashboardOutlined,
  FundOutlined,
  GlobalOutlined,
  LogoutOutlined,
  MailOutlined,
  MenuOutlined,
  PushpinFilled,
  PushpinOutlined,
  SafetyOutlined,
  ScheduleOutlined,
  SettingOutlined,
  SwapOutlined,
  TranslationOutlined,
  WalletOutlined,
} from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { Drawer, Layout, Menu, Tooltip, type MenuProps } from 'antd';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router';
import { post } from '../api/client.ts';
import { setLanguage } from '../i18n/index.ts';
import { useTheme } from '../theme/ThemeProvider.tsx';

const PIN_KEY = 'zui-sidebar-pinned';

function readPinned() {
  try {
    return localStorage.getItem(PIN_KEY) === '1';
  } catch {
    return false;
  }
}

export function Logo() {
  return <img src="/favicon.svg" className="brand-logo" alt="" />;
}

/** 3x-ui style sidebar: a 72px rail that expands on hover; pin it to keep it open. */
export function AppSidebar() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { mode, cycle } = useTheme();
  const qc = useQueryClient();
  const [pinned, setPinned] = useState(readPinned);
  const [hover, setHover] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const collapsed = !pinned && !hover;

  const main: MenuProps['items'] = useMemo(
    () => [
      { key: '/', icon: <DashboardOutlined />, label: t('nav.dashboard') },
      { key: '/accounts', icon: <WalletOutlined />, label: t('nav.accounts') },
      { key: '/cards', icon: <CreditCardOutlined />, label: t('nav.cards') },
      { key: '/transactions', icon: <SwapOutlined />, label: t('nav.transactions') },
      { key: '/bills', icon: <ScheduleOutlined />, label: t('nav.bills') },
      { key: '/statements', icon: <AppstoreOutlined />, label: t('nav.statements') },
      { key: '/invest', icon: <FundOutlined />, label: t('nav.invest') },
      { key: '/stats', icon: <BarChartOutlined />, label: t('nav.stats') },
      { key: '/fx', icon: <GlobalOutlined />, label: t('nav.fx') },
    ],
    [t],
  );
  const utility: MenuProps['items'] = useMemo(
    () => [
      { key: '/notify', icon: <MailOutlined />, label: t('nav.notify') },
      { key: '/settings', icon: <SettingOutlined />, label: t('nav.settings') },
      { key: '/security', icon: <SafetyOutlined />, label: t('nav.security') },
      { key: 'logout', icon: <LogoutOutlined />, label: t('nav.logout'), danger: true },
    ],
    [t],
  );

  const selected = '/' + (location.pathname.split('/')[1] ?? '');
  const onClick: MenuProps['onClick'] = async ({ key }) => {
    setDrawer(false);
    if (key === 'logout') {
      await post('/auth/logout').catch(() => {});
      qc.clear();
      qc.setQueryData(['me'], null);
      navigate('/login');
      return;
    }
    navigate(key);
  };

  const togglePin = () => {
    const next = !pinned;
    setPinned(next);
    try {
      localStorage.setItem(PIN_KEY, next ? '1' : '0');
    } catch {
      /* ignore */
    }
  };

  const toggleLang = () => setLanguage(i18n.language === 'en' ? 'zh-CN' : 'en');
  const themeLabel = `${t('nav.theme')} · ${t(`theme.${mode}`)}`;
  const menuTheme = mode === 'light' ? 'light' : 'dark';

  const footer = (
    <div className="sider-footer">
      <Tooltip title={themeLabel} placement="right">
        <button className="icon-btn" onClick={cycle} aria-label={themeLabel}>
          <BulbOutlined />
        </button>
      </Tooltip>
      <Tooltip title={t('nav.language')} placement="right">
        <button className="icon-btn" onClick={toggleLang} aria-label={t('nav.language')}>
          <TranslationOutlined />
        </button>
      </Tooltip>
    </div>
  );

  return (
    <>
      <div className={`app-sidebar ${pinned ? 'pinned' : ''}`} onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
        <Layout.Sider collapsed={collapsed} collapsedWidth={72} width={224} theme={menuTheme} trigger={null}>
          <div className="sider-brand">
            <span className="brand-block">
              <Logo />
              {!collapsed && <span>{t('app.name')}</span>}
            </span>
            {!collapsed && (
              <Tooltip title={pinned ? t('nav.unpin') : t('nav.pin')}>
                <button className={`icon-btn ${pinned ? 'active' : ''}`} onClick={togglePin} aria-label={t('nav.pin')}>
                  {pinned ? <PushpinFilled /> : <PushpinOutlined />}
                </button>
              </Tooltip>
            )}
          </div>
          <div className="sider-nav">
            <Menu theme={menuTheme} mode="inline" selectedKeys={[selected]} items={main} onClick={onClick} />
          </div>
          <div className="sider-utility">
            <Menu theme={menuTheme} mode="inline" selectedKeys={[selected]} items={utility} onClick={onClick} />
            {footer}
          </div>
        </Layout.Sider>
      </div>

      <button className="drawer-handle" onClick={() => setDrawer(true)} aria-label="menu">
        <MenuOutlined />
      </button>
      <Drawer
        open={drawer}
        placement="left"
        size={260}
        closable={false}
        onClose={() => setDrawer(false)}
        rootClassName="nav-drawer"
        styles={{ body: { padding: 0, display: 'flex', flexDirection: 'column' } }}
      >
        <div className="sider-brand" style={{ paddingLeft: 20 }}>
          <span className="brand-block">
            <Logo />
            <span>{t('app.name')}</span>
          </span>
          <button className="icon-btn" onClick={() => setDrawer(false)} aria-label={t('common.close')}>
            <CloseOutlined />
          </button>
        </div>
        <Menu className="drawer-menu" theme={menuTheme} mode="inline" selectedKeys={[selected]} items={main} onClick={onClick} style={{ flex: 1 }} />
        <div className="sider-utility">
          <Menu className="drawer-menu" theme={menuTheme} mode="inline" selectedKeys={[selected]} items={utility} onClick={onClick} />
          {footer}
        </div>
      </Drawer>
    </>
  );
}
