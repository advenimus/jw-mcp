import Base from "./Autopreview.js";

export default class AutoPreviewForVue extends Base {
  constructor(selector, options = {}) {
    super(selector);
    this.framework = 'vue';
    this.version = 2;
    this.options = options;
  }
  /**
   * @param {Array<{ name:string, component:object}>} [components]
   * @param {number} [index]
   * @returns {void}
   */
  async _showComponent(components, index = 0) {
    const { default: Vue } = await import('vue');

    let component;
    if (components.length === 0) {
      component = function () {
        return '';
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

    const defaultComponent = components.find(c => c.name === 'default');
    if (defaultComponent) {
      Vue.component(name, defaultComponent.component);
    }
    components.forEach((item) => Vue.component(item.name, item.component));
    const app = new Vue(Object.assign(this.options, {
      render(h) {
        return component(h);
      }
    }));

    const rootComponent = app.$mount();
    this.createTarget().appendChild(rootComponent.$el);
  }
}

export const AutoPreview = AutoPreviewForVue;
