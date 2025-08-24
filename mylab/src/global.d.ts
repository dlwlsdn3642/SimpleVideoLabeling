declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

declare global {
  interface Window {
    __INJECT_ERR?: string;
    MP4Box?: any;
  }
}

declare module 'mp4box' {
  export function createFile(...args: any[]): any;
  export const DataStream: any;
}
