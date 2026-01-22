declare module "d3-org-chart" {
  export class OrgChart {
    container(_: any): this;
    data(_: any): this;
    nodeWidth(_: any): this;
    nodeHeight(_: any): this;
    childrenMargin(_: any): this;
    compactMarginBetween(_: any): this;
    compactMarginPair(_: any): this;
    nodeContent(_: any): this;
    render(): this;

    // optional helpers you use
    fit?(): this;
    expandAll?(): this;
    collapseAll?(): this;
  }
}
