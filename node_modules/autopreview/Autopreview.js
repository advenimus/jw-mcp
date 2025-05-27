import { getActiveFilePath } from "./index.js";
import './components/list/index.js';
import './css/index.css';

let initiated = false;

export default class AutoPreview {
  /**
   * 
   * @param {string | Element} selector 
   * @returns {Promise<unknown>}
   */
  constructor(selector) {
    if (initiated) { throw new Error(`AutoPreview already initiated`); }

    /** @type {string} */
    this.activeFile = getActiveFilePath();

    /** @type {number} */
    this.componentIndex = 0;

    /** @type { Array<{name: string; component: any}> } */
    this.components = [];

    /** @type {boolean} */
    this.center = false;

    /** @type {boolean} */
    this.componentMounted = false;

    /** @type {boolean} */
    this.loading = false;

    try {
      /** @type {'webpack'|'vite'} */
      this.buildTool = __webpack_exports__ && 'webpack';
    } catch (_) {
      this.buildTool = 'vite';
    }

    const root = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (!root) {
      window.parent.postMessage({ command: 'ERROR', data: `Root element with selector ${selector} not found` }, '*');
      throw new Error(`Root element with selector ${selector} not found`);
    }

    const url = new URL(location.href);
    const autopreview = url.searchParams.get('AutoPreview');
    if (!autopreview) { return; };

    const wsPort = url.searchParams.get('wsPort');

    /** @type {WebSocket} */
    this.ws = new WebSocket(`ws://localhost:${wsPort}?client=package`);
    this.ws.onopen = () => {
      // mark the mounted target, so that we can use dataset to select element, avoid id lost after mount
      root.dataset.autopreview = '';
      this.ws.onmessage = this.onReceiveMessage.bind(this);
      this.sendMessage('update', { packageInitiated: true });
      initiated = true;
    };
  }


  /**
   * @param {string} action 
   * @param {any} data 
   */
  sendMessage(action, data) {
    if (!this.ws) { return; };
    this.ws.send(JSON.stringify({ id: Date.now().toString, action, data }));
  }

  /**
   * @param {MessageEvent} e
   */
  async onReceiveMessage(e) {
    const { id, action, data } = JSON.parse(e.data);
    /** @type {Array<'activeFile' | 'componentIndex' | 'center' | 'componentMounted'>} */
    const keys = Object.keys(data).filter(key => ['activeFile', 'componentIndex', 'center', 'componentMounted'].includes(key));
    const root = document.querySelector('[data-autopreview]');
    switch (action) {
      case 'init':
        this.activeFile = data.activeFile;
        this.center = data.center;
        this.componentIndex = data.componentIndex;
        if (this.activeFile) {
          await this.getComponents();
          await this.showComponent();
        }
        if (keys.includes('center')) {
          this.applyAlignment(this.center);
        }
        break;
      case 'update':
        // if (data.componentMounted === false) { return; }; 
        const center = this.center;
        const activeFile = this.activeFile;
        const componentIndex = this.componentIndex;
        keys.forEach(key => this[key] = data[key]);
        if (keys.includes('center') && data.center !== center) {
          this.applyAlignment(data.center);
        }
        if ((keys.includes('activeFile') && data.activeFile !== activeFile)) {
          await this.getComponents();
          await this.showComponent();
        } else if (keys.includes('componentIndex') && data.componentIndex !== componentIndex) {
          await this.showComponent();
        }
        if (data.componentMounted === true) {
          root.classList.add('autopreview-mounted');
        }
        break;
      default:
        return;
    }
  }

  async getComponents() {
    const activeModule = await this.getModule() || {};
    const keys = Object.keys(activeModule)
      .filter((key) => {
        if (key.toLowerCase().startsWith("autopreview")) {
          return true;
        }
        return false;
      });
    this.components = keys
      .map((key) => {
        return {
          name: key,
          component: activeModule[key]
        };
      });
    this.sendMessage('update', {
      'components': keys
    });
  }

  async showComponent() {
    if (this.loading) { return; };
    this.loading = true;
    // if (this.buildTool === 'webpack') {
    //   // HMR unable to update AutoPreview_ function, manually update is required, avoid HMR and manually update at the same time
    //   await new Promise((resolve, reject) => setTimeout(resolve, 500));
    // }
    await this._showComponent(this.components, this.componentIndex);
    this.applyAlignment(this.center);
    // await new Promise(resolve => setTimeout(resolve, 500));
    this.sendMessage('update', { componentMounted: true });
    this.loading = false;
  }

  /**
   * @param {Array<{ name:string, component:object}>} [components]
  * @param {number} [index]
  * @returns {void}
  */
  async _showComponent(components, index = 0) {
    // 
  }

  /**
   * The previewed component will be mounted here
   */
  createTarget() {
    let target = document.querySelector('[data-autopreview]');
    if (!target) {
      throw new Error('No target found');
    }
    const parent = target.parentElement;
    parent.removeChild(target);
    target = document.createElement('div');
    target.dataset.autopreview = '';
    parent.appendChild(target);

    const wrapper = document.createElement('div');
    wrapper.dataset.autopreviewWrapper = '';
    target.appendChild(wrapper);

    return wrapper;
  }

  /**
   * 
   * @param {boolean} center alignment
   */
  applyAlignment(center) {
    const root = document.querySelector('[data-autopreview]');
    if (center) {
      root.classList.remove('align-left-top');
      root.classList.add('align-center');
    } else {
      root.classList.remove('align-center');
      root.classList.add('align-left-top');
    }
  }

  /**
   * 
   * @returns {Promise<undefined | object>}
   */
  async getModule() {
    try {
      const getter = await import('autopreview/index');
      if (!getter) { return; };
      const activeModule = await getter.default();
      if (!activeModule) { return; };
      return activeModule;
    } catch (err) {
      console.warn(err.message);
    }
    return;
  }

}







