import Base from "./Autopreview.js";

export default class AutoPreviewForVue extends Base {
  constructor(selector, beforeMount) {
    super(selector);
    this.framework = 'vue';
    this.version = 3;
    this.beforeMount = beforeMount;
  }
  /**
   * @param {Array<{ name:string, component:object}>} [components]
   * @param {number} [index]
   * @returns {void}
   */
  async _showComponent(components, index = 0) {
    const Vue = await import('vue');

    let component;
    if (components.length === 0) {
      component = {
        render() {
          return '';
        },
      };
    } else if (components.length === 1) {
      component = components[0].component;
    } else {
      component = components[index].component;
    }

    const activeFile = this.activeFile;
    const filename = activeFile.match(/[ \w-]+\./) || [''];
    const name = filename[0].replace(/\./g, '');
    if (!name) {
      return;
    }

    const app = Vue.createApp({
      render() {
        return Vue.h(component);
      }
    });
    const asyncComponent = Vue.defineAsyncComponent(() => import(activeFile));
    app.component(name, asyncComponent);
    components.forEach(item => app.component(item.name, item.component));

    if (this.beforeMount) { this.beforeMount(app); }
    app.mount(this.createTarget());
  }
}

export const AutoPreview = AutoPreviewForVue;
