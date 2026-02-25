import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium transition-all duration-200 cursor-pointer disabled:pointer-events-none disabled:opacity-50 active:scale-[0.97] [&_svg]:pointer-events-none [&_svg]:shrink-0",
    {
        variants: {
            variant: {
                default:
                    "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 hover:shadow-md hover:shadow-primary/20",
                destructive:
                    "bg-destructive/10 text-destructive border border-destructive/20 hover:bg-destructive/20",
                outline:
                    "border border-border bg-transparent hover:bg-secondary hover:text-secondary-foreground",
                secondary:
                    "bg-secondary text-secondary-foreground border border-border hover:bg-secondary/80",
                ghost:
                    "hover:bg-secondary hover:text-secondary-foreground",
                link: "text-primary underline-offset-4 hover:underline",
            },
            size: {
                default: "h-12 px-6 py-3 text-base",
                sm: "h-10 px-4 py-2 text-sm",
                xs: "h-8 px-3 py-1.5 text-xs rounded-md",
                lg: "h-14 px-8 py-4 text-lg",
                icon: "h-12 w-12",
                "icon-sm": "h-10 w-10",
            },
        },
        defaultVariants: {
            variant: "default",
            size: "default",
        },
    }
);

export interface ButtonProps
    extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
    asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
    ({ className, variant, size, asChild = false, ...props }, ref) => {
        const Comp = asChild ? Slot : "button";
        return (
            <Comp
                className={cn(buttonVariants({ variant, size, className }))}
                ref={ref}
                {...props}
            />
        );
    }
);
Button.displayName = "Button";

export { Button, buttonVariants };
