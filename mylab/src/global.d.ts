declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

declare global {
  interface Window {
    __INJECT_ERR?: string;
  }
}

