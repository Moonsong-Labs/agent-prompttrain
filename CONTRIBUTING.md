# Contributing to Agent PromptTrain

Thank you for your interest in contributing! This guide will help you get started.

## Code of Conduct

Please be respectful and constructive in all interactions. We aim to maintain a welcoming environment for all contributors.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/yourusername/agent-prompttrain.git`
3. Create a feature branch: `git checkout -b feature/your-feature-name`
4. Make your changes
5. Submit a pull request

## Development Setup

See [Development Guide](docs/DEVELOPMENT.md) for detailed setup instructions.

Quick start:

```bash
bun install  # This also installs git pre-commit hooks
bun run dev
```

### Git Pre-commit Hooks

The project uses Husky for automated pre-commit checks. These are installed automatically when you run `bun install`.

**Pre-commit checks include:**

- ESLint for code quality (with automatic fixes)
- Prettier for code formatting (with automatic fixes)

**Note:** TypeScript type checking is not included in pre-commit hooks for performance reasons but will run in CI.

## Pull Request Process

### Before Submitting

1. **Type Check**: Ensure all TypeScript types are correct

   ```bash
   bun run typecheck
   ```

2. **Format Code**: Use Prettier for consistent formatting

   ```bash
   bun run format
   ```

3. **Test**: Run the test suite

   ```bash
   bun test
   ```

4. **Documentation**: Update relevant documentation for new features

### PR Guidelines

- **Title**: Use conventional commit format (e.g., `feat: add OAuth support`)
- **Description**: Clearly explain what changes were made and why
- **Size**: Keep PRs focused and reasonably sized
- **Tests**: Include tests for new functionality

### Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` New features
- `fix:` Bug fixes
- `docs:` Documentation changes
- `style:` Code style changes (formatting, etc.)
- `refactor:` Code refactoring
- `test:` Test additions or modifications
- `chore:` Maintenance tasks

Examples:

```
feat: add conversation branching support
fix: resolve memory leak in streaming responses
docs: update API reference for new endpoints
```

## Development Guidelines

### Code Style

- Use TypeScript for all new code
- Follow existing patterns in the codebase
- Prefer functional programming where appropriate
- Keep functions small and focused
- Add types for all function parameters and returns

### Architecture Principles

- Maintain separation between proxy and dashboard services
- Keep shared types in `packages/shared`
- Use dependency injection for testability
- Follow single responsibility principle

### Performance Considerations

- Minimize proxy overhead
- Use streaming where possible
- Cache appropriately in dashboard
- Profile before optimizing

## Adding Features

### New API Endpoints

1. Define types in `packages/shared/src/types/`
2. Implement handler in appropriate service
3. Add tests
4. Update API documentation

### Database Changes

1. Create migration script in `scripts/db/migrations/`
2. Use transaction for safety
3. Include rollback strategy
4. Test on development database first

### UI Components

1. Follow existing component patterns
2. Keep components focused and reusable
3. Use semantic HTML
4. Ensure accessibility

## Testing

### Writing Tests

- Test both happy path and edge cases
- Use descriptive test names
- Keep tests focused and independent
- Mock external dependencies

### Test Organization

```typescript
describe('Component/Feature', () => {
  describe('method/scenario', () => {
    it('should behave correctly when...', () => {
      // Test implementation
    })
  })
})
```

## Documentation

### When to Update Docs

- Adding new features
- Changing configuration options
- Modifying API endpoints
- Updating deployment process

### Documentation Style

- Be clear and concise
- Include code examples
- Explain the "why" not just the "how"
- Keep technical accuracy

## Reporting Issues

### Bug Reports

Include:

- Clear description of the issue
- Steps to reproduce
- Expected vs actual behavior
- Environment details (OS, Bun version, etc.)
- Relevant logs or error messages

### Feature Requests

Include:

- Use case description
- Proposed solution (if any)
- Alternative approaches considered
- Impact on existing functionality

## Security

### Reporting Security Issues

**Do not** open public issues for security vulnerabilities. Instead:

1. Email security concerns to [security contact]
2. Include detailed description
3. Wait for response before disclosure

### Security Best Practices

- Never commit credentials or secrets
- Validate all user input
- Use parameterized queries
- Keep dependencies updated
- Follow principle of least privilege

## Review Process

### What We Look For

- **Correctness**: Does it work as intended?
- **Performance**: Does it maintain good performance?
- **Security**: Are there any security concerns?
- **Tests**: Is it properly tested?
- **Documentation**: Is it documented?
- **Style**: Does it follow our conventions?

### Review Timeline

- Initial review: Within 2-3 business days
- Follow-up: Based on discussion needs
- Merge decision: After all concerns addressed

## Recognition

Contributors will be:

- Listed in release notes
- Added to contributors list
- Thanked in project documentation

## Questions?

- Open a discussion for general questions
- Check existing issues and discussions first
- Join our community chat [if applicable]

Thank you for contributing to Agent PromptTrain!
