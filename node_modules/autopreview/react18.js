import React from 'react';
import ReactDOM from 'react-dom/client';
import Base from "./Autopreview.js";

export default class AutoPreviewForReact extends Base {
  constructor(options) {
    super(options);
    this.framework = 'react';
  }
  /**
   * @param {Array<{ name:string, component:object}>} [components]
  * @param {number} [index]
  * @returns {void}
  */
  async _showComponent(components, index = 0) {
    let component = new React.Component({});
    if (components.length === 1) {
      component = components[0].component;
    } else {
      component = components[index].component;
    }
    ReactDOM.createRoot(this.createTarget()).render(component());

  }
}


export const AutoPreview = AutoPreviewForReact;
