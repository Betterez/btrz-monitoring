export interface SimpleDao {
    connect: () => Promise<void>;
}
export interface BtrzLogger {
    debug: (msg: string, args?: any) => void;
    info: (msg: string, args?: any) => void;
    error: (msg: string, args?: any) => void;
    fatal: (msg: string, args?: any) => void;
}
