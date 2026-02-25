import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
    "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
    {
        variants: {
            variant: {
                default: "bg-primary/10 text-primary border border-primary/20",
                secondary: "bg-secondary text-secondary-foreground border border-border",
                destructive: "bg-destructive/10 text-destructive border border-destructive/20",
                success: "bg-success/10 text-success border border-success/20",
                warning: "bg-warning/10 text-warning border border-warning/20",
                outline: "border border-border text-foreground",
            },
        },
        defaultVariants: {
            variant: "default",
        },
    }
);

export interface BadgeProps
    extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> { }

function Badge({ className, variant, ...props }: BadgeProps) {
    return (
        <div className={cn(badgeVariants({ variant }), className)} {...props} />
    );
}

export { Badge, badgeVariants };
