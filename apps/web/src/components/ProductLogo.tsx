type ProductLogoProps = {
  className?: string;
  decorative?: boolean;
};

export function ProductLogo({ className, decorative = false }: ProductLogoProps) {
  return (
    <span
      className={className ? `product-logo ${className}` : "product-logo"}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : "Finance Planner"}
      aria-hidden={decorative ? true : undefined}
    >
      <img
        className="product-logo-image product-logo-image-light"
        src="/brand/finance-planner-logo-light.svg"
        alt=""
        aria-hidden="true"
      />
      <img
        className="product-logo-image product-logo-image-dark"
        src="/brand/finance-planner-logo-dark.svg"
        alt=""
        aria-hidden="true"
      />
    </span>
  );
}
