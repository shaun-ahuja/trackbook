type Props = {
  values: number[];
  width?: number;
  height?: number;
  className?: string;
};

export default function Sparkline({
  values,
  width = 320,
  height = 60,
  className,
}: Props) {
  if (values.length < 2) {
    return <svg width={width} height={height} className={className} />;
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(0.5, max - min);
  const stepX = width / (values.length - 1);
  const points = values
    .map((v, i) => {
      const x = i * stepX;
      const y = height - ((v - min) / range) * (height - 6) - 3;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  const first = values[0];
  const last = values[values.length - 1];
  const up = last >= first;
  const stroke = up ? "#3ddc97" : "#ff5a78";
  const fill = up ? "rgba(61,220,151,0.10)" : "rgba(255,90,120,0.10)";

  const areaPoints = `0,${height} ${points} ${width},${height}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={className}
    >
      <polygon points={areaPoints} fill={fill} />
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth={1.4}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}
