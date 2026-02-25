/**
 * CustomSelect — A fully styled dropdown replacement for native <select>.
 * Renders a themed trigger button and a floating options list.
 */
import React, { useState, useRef, useEffect } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface SelectOption {
    value: string;
    label: string;
}

interface CustomSelectProps {
    value: string;
    onChange: (value: string) => void;
    options: SelectOption[];
    placeholder?: string;
    className?: string;
    /** Use darker styling for overlay contexts (e.g. scanner modal) */
    variant?: 'default' | 'overlay';
}

export const CustomSelect: React.FC<CustomSelectProps> = ({
    value,
    onChange,
    options,
    placeholder = 'Select...',
    className,
    variant = 'default',
}) => {
    const [isOpen, setIsOpen] = useState(false);
    const containerRef = useRef<HTMLDivElement>(null);

    // Close on outside click
    useEffect(() => {
        if (!isOpen) return;
        const handleClick = (e: MouseEvent) => {
            if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [isOpen]);

    // Close on Escape
    useEffect(() => {
        if (!isOpen) return;
        const handleKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setIsOpen(false);
        };
        document.addEventListener('keydown', handleKey);
        return () => document.removeEventListener('keydown', handleKey);
    }, [isOpen]);

    const selectedOption = options.find(o => o.value === value);

    return (
        <div ref={containerRef} className={cn("relative", className)}>
            {/* Trigger */}
            <button
                type="button"
                onClick={() => setIsOpen(!isOpen)}
                className={cn(
                    "w-full flex items-center justify-between gap-2 rounded-xl px-3 py-2.5 text-sm transition-colors cursor-pointer outline-none",
                    variant === 'overlay'
                        ? "bg-secondary border border-border text-foreground focus:ring-2 focus:ring-primary"
                        : "bg-background border border-border text-foreground focus:ring-2 focus:ring-primary"
                )}
            >
                <span className={cn(
                    "truncate text-left",
                    !selectedOption && "text-muted-foreground"
                )}>
                    {selectedOption?.label || placeholder}
                </span>
                <ChevronDown className={cn(
                    "w-4 h-4 text-muted-foreground shrink-0 transition-transform",
                    isOpen && "rotate-180"
                )} />
            </button>

            {/* Dropdown */}
            {isOpen && (
                <div className={cn(
                    "absolute z-50 w-full mt-1.5 rounded-xl border border-border shadow-xl overflow-hidden animate-fade-in",
                    variant === 'overlay' ? "bg-secondary" : "bg-card"
                )}>
                    <div className="max-h-48 overflow-y-auto py-1">
                        {options.map((option) => (
                            <button
                                key={option.value}
                                type="button"
                                onClick={() => {
                                    onChange(option.value);
                                    setIsOpen(false);
                                }}
                                className={cn(
                                    "w-full px-3 py-2.5 text-sm text-left transition-colors cursor-pointer",
                                    option.value === value
                                        ? "bg-primary/15 text-primary font-medium"
                                        : "text-foreground hover:bg-primary/5"
                                )}
                            >
                                {option.label}
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};
