/**
 * dsh-auth-session — 客户端 (浏览器) 半
 *
 * 功能: 启动时检查登录状态(GET /api/auth-check), 未登录则显示全屏登录遮罩,
 * 提交到 POST /login 完成登录后刷新页面。使用纯 DOM 实现(不依赖 React),
 * 阻断交互方式参考 OnboardingSurface 的 #root.inert 模式。
 *
 * 产物格式: window.__ModuleLoader__.load({id, factory}), 导出 {apply, inject}
 */

window.__ModuleLoader__.load({
  id: 'dsh-auth-session',
  factory: (require) => {
    'use strict';

    const CHECK_URL = '/api/auth-check';
    const LOGIN_URL = '/login';

    function apply(ctx) {
      // 登录检查 + 遮罩逻辑 (延迟到 DOM 就绪后执行)
      const run = () => {
        fetch(CHECK_URL, { credentials: 'same-origin' })
          .then((r) => r.json())
          .then((data) => {
            if (!data || data.authenticated !== true) {
              showLoginOverlay();
            }
          })
          .catch(() => {
            // 网络异常时不显示遮罩, 避免把界面锁死
          });
      };

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', run);
      } else {
        setTimeout(run, 0);
      }
    }

    /** 全屏登录遮罩 (阻断式) */
    function showLoginOverlay() {
      if (document.getElementById('dsh-auth-overlay')) return;

      const overlay = document.createElement('div');
      overlay.id = 'dsh-auth-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      Object.assign(overlay.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '2147483000',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0f1117',
        color: '#e6e6e6',
        fontFamily: 'system-ui, -apple-system, sans-serif',
      });

      const card = document.createElement('div');
      Object.assign(card.style, {
        background: '#1a1d27',
        padding: '40px',
        borderRadius: '12px',
        width: '320px',
        boxSizing: 'border-box',
      });

      const title = document.createElement('h1');
      title.textContent = 'DSH 登录';
      Object.assign(title.style, { fontSize: '20px', margin: '0 0 24px', textAlign: 'center' });

      const form = document.createElement('form');
      form.method = 'post';
      form.action = LOGIN_URL;

      const mkField = (labelText, name, type) => {
        const label = document.createElement('label');
        label.textContent = labelText;
        Object.assign(label.style, { display: 'block', margin: '12px 0 6px', fontSize: '14px', color: '#9aa0b5' });
        const input = document.createElement('input');
        input.name = name;
        input.type = type;
        input.required = true;
        if (name === 'username') input.autocomplete = 'username';
        if (type === 'password') input.autocomplete = 'current-password';
        Object.assign(input.style, {
          width: '100%',
          boxSizing: 'border-box',
          padding: '10px',
          border: '1px solid #333',
          borderRadius: '6px',
          background: '#14161f',
          color: '#fff',
          fontSize: '15px',
        });
        label.appendChild(input);
        return label;
      };

      const errBox = document.createElement('div');
      Object.assign(errBox.style, {
        color: '#ff6b6b', fontSize: '13px', marginTop: '12px', textAlign: 'center', minHeight: '18px',
      });

      const btn = document.createElement('button');
      btn.type = 'submit';
      btn.textContent = '登 录';
      Object.assign(btn.style, {
        width: '100%', marginTop: '24px', padding: '11px', background: '#4f6ef2',
        border: 'none', borderRadius: '6px', color: '#fff', fontSize: '15px', cursor: 'pointer',
      });

      form.appendChild(mkField('用户名', 'username', 'text'));
      form.appendChild(mkField('密码', 'password', 'password'));
      form.appendChild(btn);

      form.addEventListener('submit', (ev) => {
        ev.preventDefault();
        const fd = new FormData(form);
        errBox.textContent = '';
        fetch(LOGIN_URL, {
          method: 'POST',
          body: new URLSearchParams(fd),
          credentials: 'same-origin',
          redirect: 'follow',
        }).then((resp) => {
          if (resp.status === 401) {
            errBox.textContent = '用户名或密码错误';
            return;
          }
          // 登录成功 (302 已自动跟随, Cookie 已种下): 刷新加载界面
          location.reload();
        }).catch(() => {
          errBox.textContent = '网络错误, 请重试';
        });
      });

      card.appendChild(title);
      card.appendChild(form);
      card.appendChild(errBox);
      overlay.appendChild(card);
      document.body.appendChild(overlay);

      // 阻断应用根交互 (OnboardingSurface 先例)
      const root = document.getElementById('root');
      if (root && !root.hasAttribute('inert')) root.setAttribute('inert', '');
      const observer = new MutationObserver(() => {
        const r = document.getElementById('root');
        if (r && !r.hasAttribute('inert')) r.setAttribute('inert', '');
      });
      observer.observe(document.body, { childList: true, subtree: true });

      // 移除遮罩 (登录成功后页面重载, 此函数实际不再需要, 保留给未来"登出"用)
      window.__dshAuthRemoveOverlay = () => {
        observer.disconnect();
        const r = document.getElementById('root');
        if (r) r.removeAttribute('inert');
        overlay.remove();
      };
    }

    module.exports = { apply };
    return module.exports;
  },
});
