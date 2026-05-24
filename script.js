const videoElement = document.getElementById('input_video');
const canvasElement = document.getElementById('output_canvas');
const canvasCtx = canvasElement.getContext('2d');
const hudElement = document.getElementById('premium-hud-status');
const colorSwatchesElement = document.getElementById('colorSwatches');
const brushSizeInput = document.getElementById('brushSize');
const brushSizeValue = document.getElementById('brushSizeValue');
const penToolBtn = document.getElementById('penToolBtn');
const eraserToolBtn = document.getElementById('eraserToolBtn');
const undoBtn = document.getElementById('undoBtn');
const redoBtn = document.getElementById('redoBtn');
const saveBtn = document.getElementById('saveBtn');
const clearBtn = document.getElementById('clearBtn');
const toastElement = document.getElementById('toast');

let allShapes = [];
let redoStack = [];
let currentStroke = [];
let selectedShape = null;
let dragOffset = { x: 0, y: 0 };
let dragGroup = [];
let dragGroupStart = [];

let currentColor = '#F2C12E';
let currentTool = 'pen';
let brushSize = Number(brushSizeInput.value);
const colorsPalette = ['#F2C12E', '#FF395D', '#39FF88', '#00E5FF', '#7C5CFF', '#FFFFFF', '#FF8A00', '#111827'];

let smoothedX = null;
let smoothedY = null;
const smoothingFactor = 0.22;
const pointerPadding = 18;
let lastWritingAt = 0;
const edgeWritingGraceMs = 650;
const fastWritingGraceMs = 320;

let leftHandEraseStartedAt = null;
let pinchStartX = null;
let pinchStartBrushSize = brushSize;
let pinchCandidateStartedAt = null;
let pinchReleaseStartedAt = null;
let isPinchActive = false;
const eraseSwitchMs = 180;
const pinchHoldMs = 140;
const pinchReleaseMs = 120;
const minBrushSize = Number(brushSizeInput.min);
const maxBrushSize = Number(brushSizeInput.max);

let toastTimer = null;

function resize() {
    canvasElement.width = window.innerWidth;
    canvasElement.height = window.innerHeight;
}

window.addEventListener('resize', resize);
resize();

const hands = new Hands({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
});

hands.setOptions({
    maxNumHands: 2,
    modelComplexity: 1,
    minDetectionConfidence: 0.75,
    minTrackingConfidence: 0.75
});

function showToast(message) {
    toastElement.textContent = message;
    toastElement.classList.add('visible');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastElement.classList.remove('visible'), 1800);
}

function updateHUD(text, cssClass) {
    if (hudElement.textContent !== text) {
        hudElement.textContent = text;
        hudElement.className = `hud-status ${cssClass}`;
    }
}

function setTool(tool) {
    currentTool = tool;
    penToolBtn.classList.toggle('active', tool === 'pen');
    eraserToolBtn.classList.toggle('active', tool === 'eraser');
    showToast(tool === 'pen' ? 'Pen selected' : 'Eraser selected');
}

function switchToolSilently(tool) {
    if (currentTool === tool) return;
    currentTool = tool;
    refreshToolButtons();
}

function setColor(color) {
    currentColor = color;
    currentTool = 'pen';
    refreshToolButtons();
    renderColorSwatches();
}

function refreshToolButtons() {
    penToolBtn.classList.toggle('active', currentTool === 'pen');
    eraserToolBtn.classList.toggle('active', currentTool === 'eraser');
}

function renderColorSwatches() {
    colorSwatchesElement.innerHTML = '';

    colorsPalette.forEach((color) => {
        const swatch = document.createElement('button');
        swatch.type = 'button';
        swatch.className = `swatch${color === currentColor ? ' active' : ''}`;
        swatch.style.background = color;
        swatch.style.setProperty('--swatch-color', color);
        swatch.title = `Select ${color}`;
        swatch.setAttribute('aria-label', `Select color ${color}`);
        swatch.addEventListener('click', () => setColor(color));
        colorSwatchesElement.appendChild(swatch);
    });
}

function updateBrushSize(value) {
    brushSize = Math.max(minBrushSize, Math.min(maxBrushSize, Number(value)));
    brushSizeInput.value = String(brushSize);
    brushSizeValue.textContent = String(brushSize);
}

function undo() {
    saveStroke();
    const shape = allShapes.pop();
    if (!shape) return;
    redoStack.push(shape);
    clearDragSelection();
    showToast('Undo');
}

function redo() {
    const shape = redoStack.pop();
    if (!shape) return;
    allShapes.push(shape);
    showToast('Redo');
}

function clearCanvas(source = 'Canvas cleared') {
    allShapes = [];
    redoStack = [];
    currentStroke = [];
    clearDragSelection();
    showToast(source);
}

function saveImage() {
    saveStroke();

    const exportCanvas = document.createElement('canvas');
    exportCanvas.width = canvasElement.width;
    exportCanvas.height = canvasElement.height;
    const exportCtx = exportCanvas.getContext('2d');

    exportCtx.fillStyle = '#050608';
    exportCtx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
    allShapes.forEach((shape) => drawShapeOnContext(exportCtx, shape, false));

    const link = document.createElement('a');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    link.download = `airsketch-${timestamp}.png`;
    link.href = exportCanvas.toDataURL('image/png');
    link.click();
    showToast('Drawing saved as PNG');
}

function onResults(results) {
    canvasCtx.clearRect(0, 0, canvasElement.width, canvasElement.height);
    canvasCtx.save();
    canvasCtx.translate(canvasElement.width, 0);
    canvasCtx.scale(-1, 1);

    allShapes.forEach((shape) => drawPersistentShape(shape));

    let activeStatusText = 'STANDBY MODE';
    let activeStatusClass = 'layer-hover';

    if (results.multiHandLandmarks && results.multiHandLandmarks.length > 0) {
        let rightHand = null;
        let leftHand = null;

        results.multiHandLandmarks.forEach((landmarks, index) => {
            const label = results.multiHandedness[index].label;
            if (label === 'Left') rightHand = landmarks;
            if (label === 'Right') leftHand = landmarks;
        });

        if (rightHand) {
            const pointer = getSmoothedPointer(rightHand);
            const gesture = getGestureState(rightHand);
            const isPinching = updatePinchGesture(rightHand);

            if (isPinching) {
                activeStatusText = 'BRUSH SIZE CONTROL';
                activeStatusClass = 'layer-moving';
                switchToolSilently('pen');
                handleBrushSizeGesture(rightHand);
                saveStroke();
                clearDragSelection();
            } else if (gesture.isPalmOpen) {
                pinchStartX = null;
                activeStatusText = 'DRAG & MOVE MODE';
                activeStatusClass = 'layer-moving';
                handleMoveMode(pointer.x, pointer.y);
            } else if (gesture.isWriting || shouldContinueFastWriting(gesture)) {
                pinchStartX = null;
                activeStatusText = 'WRITING MODE';
                activeStatusClass = 'layer-writing';
                switchToolSilently('pen');
                handleDrawMode(pointer.x, pointer.y, 'pen');
                lastWritingAt = performance.now();
            } else {
                const timeSinceWriting = performance.now() - lastWritingAt;
                if ((!isNearCanvasEdge(pointer.x, pointer.y) && timeSinceWriting > fastWritingGraceMs) || timeSinceWriting > edgeWritingGraceMs) {
                    saveStroke();
                }
                clearDragSelection();
                if (!isNearCanvasEdge(pointer.x, pointer.y) && timeSinceWriting > fastWritingGraceMs) {
                    smoothedX = null;
                    smoothedY = null;
                }
            }

            drawPointer(pointer.x, pointer.y, gesture.isPalmOpen);
            drawHandSkeleton(rightHand, isPinching ? '#FFFFFF' : gesture.isPalmOpen ? '#00E5FF' : currentColor);
        } else {
            resetPinchGesture();
        }

        if (leftHand) {
            const leftPointer = getHandPointer(leftHand);
            const leftGesture = getGestureState(leftHand);
            handleLeftHandAssistGesture();

            if (leftGesture.hasOpenFinger || leftGesture.isPalmOpen) {
                activeStatusText = 'ERASER';
                activeStatusClass = 'layer-clearing';
                switchToolSilently('eraser');
                saveStroke();
                clearDragSelection();
                eraseWithLeftHand(leftHand);
            }

            drawHandSkeleton(leftHand, '#FF395D');
        } else {
            leftHandEraseStartedAt = null;
        }
    } else {
        if (performance.now() - lastWritingAt > edgeWritingGraceMs) {
            stopActiveGesture();
        }
        activeStatusText = 'NO HAND DETECTED';
        activeStatusClass = 'layer-hover';
    }

    canvasCtx.restore();
    updateHUD(activeStatusText, activeStatusClass);
    drawColorPalette();
}

function getSmoothedPointer(hand) {
    const rawX = hand[8].x * canvasElement.width;
    const rawY = hand[8].y * canvasElement.height;

    if (smoothedX === null || smoothedY === null) {
        smoothedX = rawX;
        smoothedY = rawY;
    } else {
        smoothedX += (rawX - smoothedX) * smoothingFactor;
        smoothedY += (rawY - smoothedY) * smoothingFactor;
    }

    return { x: smoothedX, y: smoothedY };
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function isNearCanvasEdge(x, y) {
    const edgePadding = 92;
    return (
        x < edgePadding ||
        x > canvasElement.width - edgePadding ||
        y < edgePadding ||
        y > canvasElement.height - edgePadding
    );
}

function getHandPointer(hand) {
    return {
        x: hand[8].x * canvasElement.width,
        y: hand[8].y * canvasElement.height
    };
}

function getGestureState(hand) {
    const thumbOpen = getThumbOpenState(hand);
    const indexOpen = hand[8].y < hand[6].y;
    const middleOpen = hand[12].y < hand[10].y;
    const ringOpen = hand[16].y < hand[14].y;
    const pinkyOpen = hand[20].y < hand[18].y;

    return {
        thumbOpen,
        indexOpen,
        middleOpen,
        ringOpen,
        pinkyOpen,
        hasOpenFinger: thumbOpen || indexOpen || middleOpen || ringOpen || pinkyOpen,
        isPalmOpen: indexOpen && middleOpen && ringOpen && pinkyOpen,
        isWriting: indexOpen && !middleOpen && !ringOpen && !pinkyOpen
    };
}

function shouldContinueFastWriting(gesture) {
    const timeSinceWriting = performance.now() - lastWritingAt;
    return (
        currentStroke.length > 0 &&
        gesture.indexOpen &&
        !gesture.isPalmOpen &&
        timeSinceWriting < fastWritingGraceMs
    );
}

function getThumbOpenState(hand) {
    const indexMcp = hand[5];
    const thumbTip = hand[4];
    const middleMcp = hand[9];
    const palmWidth = Math.hypot(indexMcp.x - middleMcp.x, indexMcp.y - middleMcp.y);
    const thumbIndexGap = Math.hypot(thumbTip.x - indexMcp.x, thumbTip.y - indexMcp.y);

    return thumbIndexGap > palmWidth * 1.55;
}

function isPinchGesture(hand) {
    const thumbTip = hand[4];
    const indexTip = hand[8];
    const wrist = hand[0];
    const middleMcp = hand[9];
    const thumbX = thumbTip.x * canvasElement.width;
    const thumbY = thumbTip.y * canvasElement.height;
    const indexX = indexTip.x * canvasElement.width;
    const indexY = indexTip.y * canvasElement.height;
    const handScale = Math.hypot(
        (middleMcp.x - wrist.x) * canvasElement.width,
        (middleMcp.y - wrist.y) * canvasElement.height
    );
    const pinchDistance = Math.hypot(thumbX - indexX, thumbY - indexY);
    const pinchThreshold = Math.max(18, Math.min(30, handScale * 0.26));

    return pinchDistance < pinchThreshold;
}

function updatePinchGesture(hand) {
    const now = performance.now();
    const isActuallyPinched = isPinchGesture(hand);

    if (isActuallyPinched) {
        pinchReleaseStartedAt = null;

        if (!pinchCandidateStartedAt) {
            pinchCandidateStartedAt = now;
        }

        if (isPinchActive || now - pinchCandidateStartedAt >= pinchHoldMs) {
            isPinchActive = true;
            return true;
        }

        return false;
    }

    pinchCandidateStartedAt = null;

    if (isPinchActive) {
        if (!pinchReleaseStartedAt) {
            pinchReleaseStartedAt = now;
            return true;
        }

        if (now - pinchReleaseStartedAt < pinchReleaseMs) {
            return true;
        }
    }

    resetPinchGesture();
    return false;
}

function resetPinchGesture() {
    pinchStartX = null;
    pinchCandidateStartedAt = null;
    pinchReleaseStartedAt = null;
    isPinchActive = false;
}

function handleBrushSizeGesture(hand) {
    const pinchX = ((hand[4].x + hand[8].x) / 2) * canvasElement.width;

    if (pinchStartX === null) {
        pinchStartX = pinchX;
        pinchStartBrushSize = brushSize;
        return;
    }

    const delta = pinchStartX - pinchX;
    const nextSize = Math.round(pinchStartBrushSize + delta / 18);
    updateBrushSize(nextSize);
}

function handleLeftHandAssistGesture() {
    const now = performance.now();

    if (!leftHandEraseStartedAt) {
        leftHandEraseStartedAt = now;
    }

    if (now - leftHandEraseStartedAt >= eraseSwitchMs) {
        switchToolSilently('eraser');
    }
}

function handleMoveMode(x, y) {
    saveStroke();

    if (!selectedShape) {
        const target = findClosestShape(x, y);
        if (target) {
            selectedShape = target.shape;
            dragOffset.x = x - selectedShape.x;
            dragOffset.y = y - selectedShape.y;
            dragGroup = getDragGroup(selectedShape);
            dragGroupStart = dragGroup.map((shape) => ({
                shape,
                x: shape.x,
                y: shape.y
            }));
        }
    } else {
        const nextX = x - dragOffset.x;
        const nextY = y - dragOffset.y;
        const deltaX = nextX - selectedShape.x;
        const deltaY = nextY - selectedShape.y;

        dragGroup.forEach((shape) => {
            shape.x += deltaX;
            shape.y += deltaY;
        });
    }
}

function handleDrawMode(x, y, forcedTool = currentTool) {
    clearDragSelection();
    checkPaletteSelection(x, y);

    if (forcedTool === 'eraser') {
        eraseAt(x, y);
        return;
    }

    currentStroke.push({
        x,
        y,
        color: currentColor,
        size: brushSize
    });
    drawStroke(currentStroke, currentColor, brushSize);
}

function stopActiveGesture() {
    saveStroke();
    clearDragSelection();
    smoothedX = null;
    smoothedY = null;
    resetPinchGesture();
}

function clearDragSelection() {
    selectedShape = null;
    dragGroup = [];
    dragGroupStart = [];
}

function saveStroke() {
    if (currentStroke.length > 1) {
        allShapes.push(convertToShapeObject(currentStroke));
        redoStack = [];
    }
    currentStroke = [];
}

function drawColorPalette() {
    colorsPalette.forEach((color, i) => {
        const x = 58 + i * 58;
        const y = canvasElement.height - 48;
        const radius = 16;

        canvasCtx.beginPath();
        canvasCtx.arc(x, y, radius, 0, 2 * Math.PI);
        canvasCtx.fillStyle = color;
        canvasCtx.shadowBlur = 10;
        canvasCtx.shadowColor = color;
        canvasCtx.fill();
        canvasCtx.shadowBlur = 0;

        if (color === currentColor) {
            canvasCtx.beginPath();
            canvasCtx.arc(x, y, radius + 5, 0, 2 * Math.PI);
            canvasCtx.strokeStyle = '#FFFFFF';
            canvasCtx.lineWidth = 3;
            canvasCtx.stroke();
        }
    });
}

function checkPaletteSelection(x, y) {
    const invertedX = canvasElement.width - x;
    const paletteY = canvasElement.height - 48;

    colorsPalette.forEach((color, i) => {
        const targetX = 58 + i * 58;
        const distance = Math.hypot(invertedX - targetX, y - paletteY);

        if (distance < 25) {
            setColor(color);
        }
    });
}

function drawStroke(points, color, size) {
    if (points.length < 2) return;

    canvasCtx.beginPath();
    canvasCtx.strokeStyle = color;
    canvasCtx.lineWidth = size;
    canvasCtx.lineCap = 'round';
    canvasCtx.lineJoin = 'round';
    canvasCtx.shadowBlur = Math.max(18, size * 3);
    canvasCtx.shadowColor = color;
    canvasCtx.moveTo(points[0].x, points[0].y);
    points.forEach((p) => canvasCtx.lineTo(p.x, p.y));
    canvasCtx.stroke();
    canvasCtx.shadowBlur = 0;
}

function convertToShapeObject(points) {
    const originX = points[0].x;
    const originY = points[0].y;
    const relativeOffsets = points.map((p) => ({ x: p.x - originX, y: p.y - originY }));

    return {
        x: originX,
        y: originY,
        points: relativeOffsets,
        color: points[0].color,
        size: points[0].size || 6
    };
}

function drawPersistentShape(shape) {
    drawShapeOnContext(canvasCtx, shape, shape === selectedShape || dragGroup.includes(shape));
}

function drawShapeOnContext(ctx, shape, isTargeted) {
    if (shape.points.length < 2) return;

    ctx.beginPath();
    ctx.shadowBlur = isTargeted ? 36 : Math.max(16, shape.size * 3);
    ctx.shadowColor = isTargeted ? '#00E5FF' : shape.color;
    ctx.strokeStyle = isTargeted ? '#00E5FF' : shape.color;
    ctx.lineWidth = isTargeted ? shape.size + 4 : shape.size;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.moveTo(shape.x + shape.points[0].x, shape.y + shape.points[0].y);
    shape.points.forEach((p) => ctx.lineTo(shape.x + p.x, shape.y + p.y));
    ctx.stroke();
    ctx.shadowBlur = 0;
}

function findClosestShape(x, y) {
    let targetedElement = null;
    let fallbackBoundRadius = Math.max(42, brushSize * 5);

    allShapes.forEach((shape) => {
        const dist = getDistanceToShape(shape, x, y);
        if (dist < fallbackBoundRadius) {
            fallbackBoundRadius = dist;
            targetedElement = { shape, distance: dist };
        }
    });

    return targetedElement;
}

function getDragGroup(containerShape) {
    const bounds = getShapeBounds(containerShape);
    const containerArea = (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY);

    if (containerArea < 900) return [containerShape];

    const grouped = allShapes.filter((shape) => {
        if (shape === containerShape) return true;

        const center = getShapeCenter(shape);
        return (
            center.x >= bounds.minX &&
            center.x <= bounds.maxX &&
            center.y >= bounds.minY &&
            center.y <= bounds.maxY &&
            isMostlyInsideBounds(shape, bounds)
        );
    });

    return grouped.length ? grouped : [containerShape];
}

function getShapeBounds(shape) {
    const xs = shape.points.map((point) => shape.x + point.x);
    const ys = shape.points.map((point) => shape.y + point.y);

    return {
        minX: Math.min(...xs),
        maxX: Math.max(...xs),
        minY: Math.min(...ys),
        maxY: Math.max(...ys)
    };
}

function getShapeCenter(shape) {
    const bounds = getShapeBounds(shape);
    return {
        x: (bounds.minX + bounds.maxX) / 2,
        y: (bounds.minY + bounds.maxY) / 2
    };
}

function isMostlyInsideBounds(shape, bounds) {
    const padding = 16;
    const pointsInside = shape.points.filter((point) => {
        const x = shape.x + point.x;
        const y = shape.y + point.y;

        return (
            x >= bounds.minX - padding &&
            x <= bounds.maxX + padding &&
            y >= bounds.minY - padding &&
            y <= bounds.maxY + padding
        );
    }).length;

    return pointsInside / shape.points.length > 0.55;
}

function getDistanceToShape(shape, x, y) {
    return shape.points.reduce((closest, point) => {
        const pointX = shape.x + point.x;
        const pointY = shape.y + point.y;
        return Math.min(closest, Math.hypot(pointX - x, pointY - y));
    }, Infinity);
}

function eraseAt(x, y) {
    const eraserRadius = Math.max(18, brushSize * 1.8);
    const beforeCount = allShapes.length;

    allShapes = allShapes.filter((shape) => {
        return !shape.points.some((point) => {
            const pointX = shape.x + point.x;
            const pointY = shape.y + point.y;
            return Math.hypot(pointX - x, pointY - y) <= eraserRadius;
        });
    });

    if (allShapes.length !== beforeCount) {
        redoStack = [];
    }
}

function eraseWithLeftHand(hand) {
    hand.forEach((joint) => {
        const x = joint.x * canvasElement.width;
        const y = joint.y * canvasElement.height;
        eraseAt(x, y);
        drawPointer(x, y, false, 'eraser');
    });
}

function drawPointer(x, y, isPalmOpen, forcedTool = currentTool) {
    const color = forcedTool === 'eraser' ? '#FF395D' : isPalmOpen ? '#00E5FF' : currentColor;
    const radius = forcedTool === 'eraser' ? Math.max(12, brushSize * 1.4) : 7;

    canvasCtx.beginPath();
    canvasCtx.arc(x, y, radius, 0, 2 * Math.PI);
    canvasCtx.fillStyle = forcedTool === 'eraser' ? 'rgba(255, 57, 93, 0.16)' : color;
    canvasCtx.strokeStyle = color;
    canvasCtx.lineWidth = forcedTool === 'eraser' ? 3 : 0;
    canvasCtx.shadowBlur = 20;
    canvasCtx.shadowColor = color;
    canvasCtx.fill();
    if (forcedTool === 'eraser') canvasCtx.stroke();
    canvasCtx.shadowBlur = 0;
}

function drawHandSkeleton(hand, color) {
    const connections = [
        [0, 1], [1, 2], [2, 3], [3, 4],
        [0, 5], [5, 6], [6, 7], [7, 8],
        [5, 9], [9, 10], [10, 11], [11, 12],
        [9, 13], [13, 14], [14, 15], [15, 16],
        [13, 17], [17, 18], [18, 19], [19, 20],
        [0, 17]
    ];

    canvasCtx.save();
    canvasCtx.lineCap = 'round';
    canvasCtx.lineJoin = 'round';

    connections.forEach(([start, end]) => {
        const startPoint = hand[start];
        const endPoint = hand[end];
        const startX = startPoint.x * canvasElement.width;
        const startY = startPoint.y * canvasElement.height;
        const endX = endPoint.x * canvasElement.width;
        const endY = endPoint.y * canvasElement.height;

        canvasCtx.beginPath();
        canvasCtx.moveTo(startX, startY);
        canvasCtx.lineTo(endX, endY);
        canvasCtx.strokeStyle = color;
        canvasCtx.lineWidth = 2;
        canvasCtx.globalAlpha = 0.78;
        canvasCtx.shadowBlur = 14;
        canvasCtx.shadowColor = color;
        canvasCtx.stroke();
    });

    hand.forEach((point, index) => {
        const x = point.x * canvasElement.width;
        const y = point.y * canvasElement.height;
        const isTip = [4, 8, 12, 16, 20].includes(index);

        canvasCtx.beginPath();
        canvasCtx.arc(x, y, isTip ? 4.8 : 3.2, 0, 2 * Math.PI);
        canvasCtx.fillStyle = isTip ? '#FFFFFF' : color;
        canvasCtx.globalAlpha = isTip ? 0.95 : 0.72;
        canvasCtx.shadowBlur = isTip ? 18 : 10;
        canvasCtx.shadowColor = color;
        canvasCtx.fill();
    });

    canvasCtx.restore();
}

penToolBtn.addEventListener('click', () => setTool('pen'));
eraserToolBtn.addEventListener('click', () => setTool('eraser'));
brushSizeInput.addEventListener('input', (event) => updateBrushSize(event.target.value));
undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);
saveBtn.addEventListener('click', saveImage);
clearBtn.addEventListener('click', () => clearCanvas('Canvas cleared'));

window.addEventListener('keydown', (event) => {
    const key = event.key.toLowerCase();

    if ((event.ctrlKey || event.metaKey) && key === 'z') {
        event.preventDefault();
        undo();
    }

    if ((event.ctrlKey || event.metaKey) && key === 'y') {
        event.preventDefault();
        redo();
    }

    if (key === 'e') setTool('eraser');
    if (key === 'p') setTool('pen');

    if (event.code === 'Space') {
        event.preventDefault();
        clearCanvas('Canvas cleared');
    }
});

renderColorSwatches();
updateBrushSize(brushSizeInput.value);
refreshToolButtons();

hands.onResults(onResults);

const camera = new Camera(videoElement, {
    onFrame: async () => {
        await hands.send({ image: videoElement });
    },
    width: 1280,
    height: 720
});

camera.start().catch(() => {
    updateHUD('CAMERA BLOCKED', 'layer-clearing');
    showToast('Allow camera access to start Airpen');
});
