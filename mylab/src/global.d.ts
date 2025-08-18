declare module '*.module.css' {
  const classes: { readonly [key: string]: string };
  export default classes;
}

declare global {
  interface Window {
    __INJECT_ERR?: string;
  }
}

// Vite worker import type
declare module '*?worker' {
  const WorkerFactory: { new (): Worker };
  export default WorkerFactory;
}
