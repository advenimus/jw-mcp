class AutoPreviewList extends HTMLElement {
  constructor() {
    super();
  }
  connectedCallback() {
    this.style.display = 'flex';
    this.style.flexDirection = 'column';
    this.style.height = '100%';
    this.childNodes.forEach(node => {
      node.style.marginBottom = '10px';
    });
  }
}

customElements.define('autopreview-list', AutoPreviewList);