import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';

export default function CustomEdge({
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    style = {},
    markerEnd,
    data,
}: EdgeProps) {
    const [edgePath, labelX, labelY] = getBezierPath({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
    });

    const condition = (data?.condition as string) || '';

    // Get color based on condition keywords
    const getConditionColor = () => {
        const lower = condition.toLowerCase();
        if (lower.includes('error') || lower.includes('fail') || lower.includes('wrong')) {
            return '#EF4444'; // red
        }
        if (lower.includes('complete') || lower.includes('success')) {
            return '#8B5CF6'; // purple
        }
        return '#3B82F6'; // blue (default/always)
    };

    const edgeColor = getConditionColor();

    return (
        <>
            <BaseEdge
                path={edgePath}
                markerEnd={markerEnd}
                style={{ ...style, stroke: edgeColor, strokeWidth: 2 }}
                id={id}
            />
            {/* Read-only condition label (only show if not default "Always") */}
            {condition && condition !== 'Always' && (
                <EdgeLabelRenderer>
                    <div
                        style={{
                            position: 'absolute',
                            transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
                            pointerEvents: 'none',
                        }}
                        className="nodrag nopan"
                    >
                        <span
                            className="px-2 py-0.5 bg-claude-surface dark:bg-claude-darkSurface border text-[10px] font-medium rounded-md shadow-sm max-w-[120px] truncate"
                            style={{
                                borderColor: edgeColor,
                                color: edgeColor,
                            }}
                        >
                            {condition}
                        </span>
                    </div>
                </EdgeLabelRenderer>
            )}
        </>
    );
}
