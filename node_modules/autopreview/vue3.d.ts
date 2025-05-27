/// <reference path = "components/components.d.ts" />

declare module "autopreview/vue3" {
  export default class {
    constructor(selector: string | Element, beforeMount?: (app: any) => void);
  }
}
