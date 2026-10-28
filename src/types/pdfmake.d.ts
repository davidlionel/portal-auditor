// The parts of pdfmake's browser build the playbook uses. pdfmake 0.3 ships
// no types of its own.
declare module "pdfmake/build/pdfmake.js" {
  type OutputDocument = { getBlob(): Promise<Blob>; getBuffer(): Promise<Uint8Array> };
  const pdfMake: {
    createPdf(docDefinition: object): OutputDocument;
    addVirtualFileSystem(vfs: Record<string, string>): void;
    setUrlAccessPolicy(callback: (url: string) => boolean): void;
    addTableLayouts(layouts: object): void;
  };
  export default pdfMake;
}

declare module "pdfmake/build/vfs_fonts.js" {
  const vfs: Record<string, string>;
  export default vfs;
}
