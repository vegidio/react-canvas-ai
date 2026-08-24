import type { ReactElement, ReactNode } from 'react';
import { createContext, useContext } from 'react';
import type { UseMaskEditorProps, UseMaskEditorReturn } from '../hooks/useMaskEditor';
import { useMaskEditor } from '../hooks/useMaskEditor';

export type MaskEditorContextValue = UseMaskEditorReturn;

const MaskEditorContext = createContext<MaskEditorContextValue | undefined>(undefined);

export type MaskEditorProviderProps = UseMaskEditorProps & { children: ReactNode };

export const MaskEditorProvider = ({ children, ...props }: MaskEditorProviderProps): ReactElement => {
    // `useMaskEditor` memoizes its return, so consumers only re-render when something it
    // exposes actually changed — this used to be a fresh object on every provider render.
    const value = useMaskEditor(props);
    return <MaskEditorContext value={value}>{children}</MaskEditorContext>;
};

export const useMaskEditorContext = (): MaskEditorContextValue => {
    const ctx = useContext(MaskEditorContext);
    if (!ctx) throw new Error('useMaskEditorContext must be used within a MaskEditorProvider');
    return ctx;
};
