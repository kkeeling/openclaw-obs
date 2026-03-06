interface MetricCardProps {
  label: string;
  value: string;
  subtext?: string;
  loading?: boolean;
}

export default function MetricCard({ label, value, subtext, loading }: MetricCardProps) {
  if (loading) {
    return (
      <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4">
        <div className="skeleton h-3 w-20 mb-3" />
        <div className="skeleton h-7 w-28 mb-2" />
        <div className="skeleton h-3 w-16" />
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg p-4">
      <p className="text-xs text-gray-500 dark:text-gray-400 uppercase tracking-wide font-medium">
        {label}
      </p>
      <p className="text-2xl font-semibold mt-1 font-mono">{value}</p>
      {subtext && (
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">{subtext}</p>
      )}
    </div>
  );
}
