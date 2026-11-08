// One brightness slider covering two kinds of dimming. Above the breakpoint it drives
// the display's own brightness, and below it the display stays at its minimum while its
// picture is dimmed further (see DisplayDimmer). Pure, so the mapping can be tested on its own.

// Keeps every display readable, so nobody ends up unable to see the controls
const MINIMUM_DIM_LEVEL = 5

function splitSliderLevel(level, breakpoint) {
    if (level >= breakpoint) return { hardware: (level - breakpoint) * 100 / (100 - breakpoint), dim: 100 }
    return { hardware: 0, dim: Math.round(MINIMUM_DIM_LEVEL + (level * (100 - MINIMUM_DIM_LEVEL) / breakpoint)) }
}

function sliderLevelForDim(dim, breakpoint) {
    return Math.round((dim - MINIMUM_DIM_LEVEL) * breakpoint / (100 - MINIMUM_DIM_LEVEL))
}

function sliderLevelForHardware(hardware, breakpoint) {
    return Math.round(breakpoint + (hardware * (100 - breakpoint) / 100))
}

// Moves a saved slider level to a different mapping, so it keeps meaning the same
// brightness. A breakpoint of null means the slider was the display's own brightness.
function convertSliderLevel(level, fromBreakpoint, toBreakpoint) {
    if (fromBreakpoint === toBreakpoint) return level
    if (fromBreakpoint && level < fromBreakpoint) return (toBreakpoint ? Math.round(level * toBreakpoint / fromBreakpoint) : 0)
    const hardware = (fromBreakpoint ? splitSliderLevel(level, fromBreakpoint).hardware : level)
    return (toBreakpoint ? sliderLevelForHardware(hardware, toBreakpoint) : Math.round(hardware))
}

// A display can also have its own dim slider, and the two add up
function combineDimLevels(first, second) {
    return Math.round(first * second / 100)
}

module.exports = { MINIMUM_DIM_LEVEL, splitSliderLevel, sliderLevelForDim, sliderLevelForHardware, convertSliderLevel, combineDimLevels }
