export type OfflineBundleEntry={type:string};
export function offlineAssetsFromBundle(bundle:Record<string,OfflineBundleEntry>):string[];
export function renderOfflineWorker(template:string,assets:readonly string[]):string;
