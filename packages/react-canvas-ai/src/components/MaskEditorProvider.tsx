import React from 'react';
import type { UseMaskEditorProps, UseMaskEditorReturn } from '../hooks/useMaskEditor';
import { useMaskEditor } from '../hooks/useMaskEditor';

export interface MaskEditorContextValue extends UseMaskEditorReturn {}

const MaskEditorContext = React.createContext<MaskEditorContextValue | undefined>(undefined);

export const MaskEditorProvider: React.FC<UseMaskEditorProps & { children: React.ReactNode }> = ({
    children,
    ...props
}) => {
    // `useMaskEditor` memoizes its return, so consumers only re-render when something it
    // exposes actually changed — this used to be a fresh object on every provider render.
    const value = useMaskEditor(props);
    return <MaskEditorContext.Provider value={value}>{children}</MaskEditorContext.Provider>;
};

export function useMaskEditorContext(): MaskEditorContextValue {
    const ctx = React.useContext(MaskEditorContext);
    if (!ctx) throw new Error('useMaskEditorContext must be used within a MaskEditorProvider');
    return ctx;
}
