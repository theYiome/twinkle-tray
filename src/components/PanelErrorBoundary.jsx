import React from "react"

// Keeps a problem with one part of the panel from blanking all of it. React unmounts
// everything on an uncaught render error, and the panel is then empty until it restarts.
export default class PanelErrorBoundary extends React.Component {
    constructor(props) {
        super(props)
        this.state = { failed: false }
    }

    static getDerivedStateFromError() {
        return { failed: true }
    }

    componentDidCatch(error) {
        console.error(`The panel couldn't show ${this.props.name}:`, error)
    }

    // New data may well be fine, so it gets another try
    componentDidUpdate(previous) {
        if (this.state.failed && previous.retryKey !== this.props.retryKey) this.setState({ failed: false })
    }

    render() {
        return (this.state.failed ? null : this.props.children)
    }
}
