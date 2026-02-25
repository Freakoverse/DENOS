// Satoshi symbol icon using Font Awesome kit (same as PWANS)

interface SatoshiIconProps {
    className?: string;
}

export function SatoshiIcon({ className = '' }: SatoshiIconProps) {
    return (
        <i className={`fak fa-satoshisymbol-solid ${className}`} />
    );
}
