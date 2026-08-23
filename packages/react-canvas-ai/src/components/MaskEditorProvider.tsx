import type { FC, ReactNode } from 'react';
import { createContext, useContext } from 'react';
import type { UseMaskEditorProps, UseMaskEditorReturn } from '../hooks/useMaskEditor';
import { useMaskEditor } from '../hooks/useMaskEditor';

export type MaskEditorContextValue = UseMaskEditorReturn;

const MaskEditorContext = createContext<MaskEditorContextValue | undefined>(undefined);

export const MaskEditorProvider: FC<UseMaskEditorProps & { children: ReactNode }> = ({ children, ...props }) => {
    // `useMaskEditor` memoizes its return, so consumers only re-render when something it
    // exposes actually changed — this used to be a fresh object on every provider render.
    const value = useMaskEditor(props);
    return <MaskEditorContext.Provider value={value}>{children}</MaskEditorContext.Provider>;
};

export const useMaskEditorContext = (): MaskEditorContextValue => {
    const ctx = useContext(MaskEditorContext);
    if (!ctx) throw new Error('useMaskEditorContext must be used within a MaskEditorProvider');
    return ctx;
};
